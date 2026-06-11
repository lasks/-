# 现场运维工具箱

现场实施工作中常用的脚本和工具集合，随用随改。

## 文件说明

| 文件 | 用途 | 使用方式 |
|------|------|---------|
| `data_toolkit.py` | 数据处理（CSV/Excel 读写、数据库导入、数据校验、去重合并、文件完整性检查） | `python data_toolkit.py --help` |
| `ai_log_analyzer.py` | AI 辅助运维（日志智能分析、自然语言生成 SQL、报错解释、实时监控） | `python ai_log_analyzer.py --help` |
| `common_queries.sql` | 常用 SQL 查询（多表关联、窗口函数、数据校验、去重、巡检） | 复制到数据库客户端执行 |
| `ops_tools.sh` | Linux 运维脚本（系统巡检、MySQL 备份、日志搜索、端口/进程检查、服务管理） | `bash ops_tools.sh --help` |

## 环境依赖

**Python 脚本**：
```bash
pip install pymysql openpyxl requests
```

**AI 脚本**需要配置 API 环境变量：
```bash
export AI_API_KEY=sk-xxxx
export AI_API_URL=https://api.deepseek.com/v1/chat/completions
export AI_MODEL=deepseek-chat
```

支持 DeepSeek / OpenAI 兼容接口，通过 CC Switch 切换国内外模型。

**Shell 脚本**：Linux / WSL / macOS 均可运行。

## 使用场景

### 数据迁移后对账
```bash
# 比对两个 CSV 的关键字段
python data_toolkit.py check --source src_orders.csv --target tgt_orders.csv --key order_id

# 检查空值率
python data_toolkit.py nulls --file orders.csv --column customer_name
```

### 日志分析与故障排查
```bash
# 分析报错日志
python ai_log_analyzer.py log --file /var/log/app_error.log

# 实时监控，发现 ERROR 自动调用 AI 分析
python ai_log_analyzer.py log --file /var/log/app.log --monitor
```

### SQL 自动生成
```bash
# 导出表结构
mysqldump -u root --no-data mydb > schema.txt

# 用自然语言描述需求，AI 生成 SQL
python ai_log_analyzer.py sql --tables schema.txt --ask "上月消费额排名前10的客户"
```

### 服务器巡检
```bash
bash ops_tools.sh check          # 一键巡检
bash ops_tools.sh backup mydb    # 备份数据库
bash ops_tools.sh ps nginx       # 检查进程状态
bash ops_tools.sh port 3306      # 检查端口监听
bash ops_tools.sh top            # 系统资源 Top5
```

## 关于

日常用 Claude / DeepSeek / Cursor 辅助工作。这个仓库里的工具都是从真实现场需求中提炼出来的——数据对账、日志排查、巡检备份，都是实施工程师的高频场景。
