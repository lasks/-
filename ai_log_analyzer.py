# -*- coding: utf-8 -*-
"""
AI辅助工具 —— 用大模型分析日志、生成SQL、解释报错。
支持 DeepSeek / OpenAI 兼容接口，用 CC Switch 切换。

用法：
  python ai_log_analyzer.py log --file error.log
  python ai_log_analyzer.py sql --tables schema.txt --ask "上月销售额Top10客户"
  python ai_log_analyzer.py explain --error "ORA-00001 unique constraint violated"

环境变量：
  export AI_API_KEY=sk-xxxx
  export AI_API_URL=https://api.deepseek.com/v1/chat/completions
  export AI_MODEL=deepseek-chat
"""

import os, sys, json, time, logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("ai_helper")

# ── 配置 ──────────────────────────────────
# 从环境变量读，没有就报错
API_KEY = os.getenv("AI_API_KEY", "")
API_URL = os.getenv("AI_API_URL", "https://api.deepseek.com/v1/chat/completions")
MODEL = os.getenv("AI_MODEL", "deepseek-chat")


def _call_ai(messages, temperature=0.3, max_tokens=2000):
    """调大模型API，失败自动重试"""
    if not API_KEY:
        log.error("没设置 AI_API_KEY 环境变量")
        return ""

    import requests

    body = {
        "model": MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }

    for attempt in range(3):
        try:
            resp = requests.post(
                API_URL,
                headers={
                    "Authorization": f"Bearer {API_KEY}",
                    "Content-Type": "application/json",
                },
                json=body,
                timeout=90,
            )
            data = resp.json()

            if "choices" in data:
                return data["choices"][0]["message"]["content"]

            # 国产API有时候字段名不一样
            if "response" in data:
                return data["response"]

            log.warning(f"API返回格式不对: {json.dumps(data, ensure_ascii=False)[:300]}")
            return ""

        except Exception as e:
            log.warning(f"调用失败 (第{attempt+1}次): {e}")
            if attempt < 2:
                time.sleep(2 ** attempt)

    log.error("重试3次都失败了")
    return ""


# ============================================================
# 功能1: 分析报错日志
# ============================================================

def analyze_log(log_text):
    """把报错日志扔给AI分析"""
    if len(log_text) > 8000:
        # 太长就取头和尾
        log_text = log_text[:4000] + "\n...省略中间...\n" + log_text[-4000:]

    system = (
        "你是数据库和系统运维专家。"
        "根据用户提供的报错日志，分析可能的原因，给出具体排查步骤。"
        "用中文回答，分点说明。优先考虑最常见的原因。"
    )

    result = _call_ai([
        {"role": "system", "content": system},
        {"role": "user", "content": f"下面是系统报错日志，帮我分析：\n\n```\n{log_text}\n```"},
    ])

    return result


def monitor_log(filepath):
    """实时监控日志文件，发现ERROR自动调用AI分析"""
    import time as t

    if not os.path.exists(filepath):
        log.error(f"文件不存在: {filepath}")
        return

    log.info(f"开始监控 {filepath} (Ctrl+C 停止)")
    last_size = os.path.getsize(filepath)
    seen_errors = set()

    try:
        while True:
            current_size = os.path.getsize(filepath)
            if current_size > last_size:
                with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                    f.seek(last_size)
                    new_lines = f.read()
                    last_size = current_size

                # 找 ERROR 行
                for line in new_lines.split("\n"):
                    if "ERROR" in line or "FATAL" in line or "Exception" in line:
                        # 简单去重，避免同一条反复分析
                        h = line.strip()[:100]
                        if h in seen_errors:
                            continue
                        seen_errors.add(h)

                        log.info(f"检测到报错，AI分析中...")
                        result = analyze_log(line.strip())
                        print(f"\n{'='*60}")
                        print(f"⚠️ 检测到异常:")
                        print(f"   {line.strip()[:200]}")
                        print(f"\n🤖 AI分析结果:")
                        print(f"   {result}")
                        print(f"{'='*60}\n")

            t.sleep(2)
    except KeyboardInterrupt:
        log.info("监控已停止")


# ============================================================
# 功能2: AI辅助生成SQL
# ============================================================

def generate_sql(table_schema, requirement):
    """根据表结构和需求，让AI生成SQL"""
    system = (
        "你是SQL专家。用户会给你表结构和查询需求。"
        "只输出SQL语句，不要多余解释。使用MySQL语法。"
        "如果有不确定的地方，在SQL注释里说明。"
    )

    prompt = f"表结构:\n{table_schema}\n\n查询需求: {requirement}"

    return _call_ai([
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ])


# ============================================================
# 功能3: 解释报错信息
# ============================================================

def explain_error(error_msg):
    """解释数据库/系统报错是什么意思"""
    system = (
        "你是技术专家，擅长用通俗的语言解释报错信息。"
        "对于每个报错，说明：1）这个报错是什么意思，2）常见原因，3）怎么修。"
        "用中文，简洁。"
    )

    return _call_ai([
        {"role": "system", "content": system},
        {"role": "user", "content": f"帮我解释这个报错：{error_msg}"},
    ])


# ============================================================
# 功能4: 生成数据校验规则
# ============================================================

def suggest_validation_rules(table_schema, business_context=""):
    """让AI帮你列出应该做的数据校验项"""
    system = (
        "你是数据质量专家。看到表结构后，你应该列出所有应该做的数据校验规则。"
        "包括：主键唯一性、外键关联完整性、空值约束、取值范围、格式校验、业务逻辑校验。"
        "输出格式：每行一条规则，格式为 '列名 | 规则类型 | 校验说明'"
    )

    prompt = f"表结构:\n{table_schema}"
    if business_context:
        prompt += f"\n\n业务背景: {business_context}"

    return _call_ai([
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ])


# ============================================================
# 5. 命令行入口
# ============================================================

if __name__ == "__main__":
    import argparse

    p = argparse.ArgumentParser(description="AI辅助运维工具")
    sub = p.add_subparsers(dest="cmd")

    # 分析日志
    l = sub.add_parser("log", help="分析报错日志文件")
    l.add_argument("--file", required=True, help="日志文件路径")
    l.add_argument("--monitor", action="store_true", help="实时监控模式")

    # 生成SQL
    s = sub.add_parser("sql", help="生成SQL查询")
    s.add_argument("--tables", required=True, help="表结构描述文件")
    s.add_argument("--ask", required=True, help="查询需求")

    # 解释报错
    e = sub.add_parser("explain", help="解释报错")
    e.add_argument("--error", required=True, help="报错信息")

    # 数据校验建议
    v = sub.add_parser("validate", help="生成数据校验规则建议")
    v.add_argument("--tables", required=True, help="表结构描述文件")
    v.add_argument("--context", default="", help="业务背景")

    args = p.parse_args()

    if args.cmd == "log":
        if args.monitor:
            monitor_log(args.file)
        else:
            with open(args.file, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()
            result = analyze_log(content)
            print(result)

    elif args.cmd == "sql":
        with open(args.tables, "r", encoding="utf-8") as f:
            schema = f.read()
        result = generate_sql(schema, args.ask)
        print(result)

    elif args.cmd == "explain":
        result = explain_error(args.error)
        print(result)

    elif args.cmd == "validate":
        with open(args.tables, "r", encoding="utf-8") as f:
            schema = f.read()
        result = suggest_validation_rules(schema, args.context)
        print(result)

    else:
        p.print_help()
