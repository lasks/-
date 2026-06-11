#!/bin/bash
# ============================================================
# Linux 运维常用脚本
# 用法: bash ops_tools.sh <功能名>
# 放在服务器上或者在 WSL 里跑都行
# ============================================================

set -e

# ── 颜色 ──────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# ── 1. 系统健康检查 ──────────────────────────
system_check() {
    echo "=========================================="
    echo "  系统巡检 - $(date '+%Y-%m-%d %H:%M:%S')"
    echo "=========================================="

    # 系统负载
    echo -e "\n${GREEN}[CPU & 负载]${NC}"
    uptime
    echo ""
    top -bn1 | head -5

    # 内存
    echo -e "\n${GREEN}[内存]${NC}"
    free -h

    # 磁盘
    echo -e "\n${GREEN}[磁盘使用]${NC}"
    df -h | grep -v "tmpfs\|snap\|loop"

    # 磁盘使用率超过80%的
    echo -e "\n${YELLOW}[磁盘告警 (>80%)]${NC}"
    df -h | awk 'NR>1 && int($5)>80 {print $0}'
    if [ $? -ne 0 ]; then
        echo "无告警"
    fi

    # 网络
    echo -e "\n${GREEN}[网络端口监听]${NC}"
    netstat -tlnp 2>/dev/null | grep LISTEN | head -20

    # 最近登录
    echo -e "\n${GREEN}[最近登录]${NC}"
    last -5 2>/dev/null || echo "无登录记录"
}


# ── 2. MySQL 数据库备份 ──────────────────────
mysql_backup() {
    DB_USER="${MYSQL_USER:-root}"
    DB_PASS="${MYSQL_PASS:-}"
    DB_NAME="${1}"
    BACKUP_DIR="${2:-./backups}"

    if [ -z "$DB_NAME" ]; then
        echo "用法: bash ops_tools.sh backup <数据库名> [备份目录]"
        exit 1
    fi

    mkdir -p "$BACKUP_DIR"

    TIMESTAMP=$(date +%Y%m%d_%H%M%S)
    FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

    echo "备份 $DB_NAME → $FILE ..."

    if [ -n "$DB_PASS" ]; then
        mysqldump -u"$DB_USER" -p"$DB_PASS" \
            --single-transaction --routines --triggers \
            "$DB_NAME" | gzip > "$FILE"
    else
        mysqldump -u"$DB_USER" \
            --single-transaction --routines --triggers \
            "$DB_NAME" | gzip > "$FILE"
    fi

    if [ $? -eq 0 ]; then
        SIZE=$(du -h "$FILE" | cut -f1)
        echo -e "${GREEN}备份成功: $FILE ($SIZE)${NC}"
    else
        echo -e "${RED}备份失败${NC}"
        exit 1
    fi

    # 删7天前的旧备份
    OLD=$(find "$BACKUP_DIR" -name "${DB_NAME}_*.sql.gz" -mtime +7 2>/dev/null)
    if [ -n "$OLD" ]; then
        echo "$OLD" | xargs rm -f
        echo "清理了7天前的旧备份"
    fi
}


# ── 3. 日志搜索封装 ──────────────────────────
grep_log() {
    LOG_FILE="${1}"
    PATTERN="${2}"
    LINES="${3:-50}"

    if [ -z "$LOG_FILE" ] || [ -z "$PATTERN" ]; then
        echo "用法: bash ops_tools.sh grep <日志文件> <搜索关键词> [上下文行数]"
        exit 1
    fi

    if [ ! -f "$LOG_FILE" ]; then
        echo -e "${RED}文件不存在: $LOG_FILE${NC}"
        exit 1
    fi

    echo "搜索 $LOG_FILE 中的 '$PATTERN' ..."
    echo "----------------------------------------"
    grep -i -B "$LINES" -A "$LINES" "$PATTERN" "$LOG_FILE" \
        | tail -200
    echo "----------------------------------------"
    TOTAL=$(grep -c -i "$PATTERN" "$LOG_FILE" 2>/dev/null || echo 0)
    echo "共匹配 $TOTAL 条"
}


# ── 4. 进程监控 ──────────────────────────────
watch_process() {
    PROC_NAME="${1}"

    if [ -z "$PROC_NAME" ]; then
        echo "用法: bash ops_tools.sh ps <进程名>"
        echo "示例: bash ops_tools.sh ps nginx"
        exit 1
    fi

    echo "查找进程: $PROC_NAME"
    echo "----------------------------------------"
    ps -ef | grep -i "$PROC_NAME" | grep -v grep | grep -v "$0"

    COUNT=$(ps -ef | grep -i "$PROC_NAME" | grep -v grep | grep -v "$0" | wc -l)
    if [ "$COUNT" -eq 0 ]; then
        echo -e "${RED}没有找到相关进程${NC}"
    else
        echo -e "${GREEN}找到 $COUNT 个进程${NC}"
    fi
}


# ── 5. 端口检查 ──────────────────────────────
check_port() {
    PORT="${1}"

    if [ -z "$PORT" ]; then
        echo "用法: bash ops_tools.sh port <端口号>"
        exit 1
    fi

    echo "检查端口 $PORT ..."
    RESULT=$(netstat -tlnp 2>/dev/null | grep ":$PORT " || true)
    if [ -n "$RESULT" ]; then
        echo -e "${GREEN}端口 $PORT 正在监听:${NC}"
        echo "$RESULT"
    else
        echo -e "${RED}端口 $PORT 未监听${NC}"
    fi
}


# ── 6. 批量文件操作 ──────────────────────────
# 场景：在现场经常要把Windows导出的GBK文件转UTF-8
convert_encoding() {
    DIR="${1:-.}"
    FROM="${2:-gbk}"
    TO="${3:-utf-8}"

    echo "转换 $DIR 下的文件编码: $FROM → $TO"

    COUNT=0
    find "$DIR" -type f \( -name "*.csv" -o -name "*.txt" -o -name "*.sql" \) | while read f; do
        # 跳过已经是UTF-8的
        if file "$f" 2>/dev/null | grep -q "UTF-8"; then
            continue
        fi
        echo "  转换: $f"
        iconv -f "$FROM" -t "$TO" "$f" -o "${f}.tmp" 2>/dev/null && mv "${f}.tmp" "$f"
        COUNT=$((COUNT + 1))
    done
    echo "完成"
}


# ── 7. 快速启动/停止服务 ──────────────────────
service_ctl() {
    ACTION="${1}"  # start / stop / restart / status
    SERVICE="${2}"

    if [ -z "$ACTION" ] || [ -z "$SERVICE" ]; then
        echo "用法: bash ops_tools.sh svc <start|stop|restart|status> <服务名>"
        echo "示例: bash ops_tools.sh svc restart mysql"
        exit 1
    fi

    echo "对 $SERVICE 执行: $ACTION"

    if command -v systemctl &>/dev/null; then
        sudo systemctl "$ACTION" "$SERVICE"
    elif [ -f "/etc/init.d/$SERVICE" ]; then
        sudo "/etc/init.d/$SERVICE" "$ACTION"
    else
        echo -e "${RED}不知道 $SERVICE 怎么管，手动吧${NC}"
        exit 1
    fi

    if [ "$ACTION" = "status" ] || [ "$ACTION" = "restart" ]; then
        systemctl status "$SERVICE" 2>/dev/null | head -10 || true
    fi
}


# ── 8. crontab 定时任务模板生成 ────────────────
cron_template() {
    echo "=========================================="
    echo "  crontab 参考 —— 常用的定时任务"
    echo "=========================================="
    echo ""
    echo "# 每天凌晨2点备份数据库"
    echo "0 2 * * * /bin/bash /opt/scripts/mysql_backup.sh >> /var/log/backup.log 2>&1"
    echo ""
    echo "# 每小时检查一次服务状态"
    echo "0 * * * * /bin/bash /opt/scripts/health_check.sh"
    echo ""
    echo "# 每周日凌晨3点清理7天前的日志"
    echo "0 3 * * 0 find /var/log/app/ -name '*.log' -mtime +7 -delete"
    echo ""
    echo "# 每隔30分钟检查磁盘使用率"
    echo "*/30 * * * * df -h | awk 'int(\$5)>80 {print \$0}' | mail -s '磁盘告警' admin@example.com"
    echo ""
    echo "启动定时任务: crontab -e"
    echo "查看当前任务: crontab -l"
}


# ── 9. 查看系统资源占用最高的进程 ──────────────
top_usage() {
    echo -e "${GREEN}CPU 占用 Top 5:${NC}"
    ps -eo pid,user,%cpu,%mem,comm --sort=-%cpu | head -6
    echo ""
    echo -e "${GREEN}内存占用 Top 5:${NC}"
    ps -eo pid,user,%cpu,%mem,comm --sort=-%mem | head -6
}


# ── 入口 ──────────────────────────────────────
case "${1}" in
    check)
        system_check
        ;;
    backup)
        mysql_backup "$2" "$3"
        ;;
    grep)
        grep_log "$2" "$3" "$4"
        ;;
    ps)
        watch_process "$2"
        ;;
    port)
        check_port "$2"
        ;;
    svc)
        service_ctl "$2" "$3"
        ;;
    top)
        top_usage
        ;;
    cron)
        cron_template
        ;;
    convert)
        convert_encoding "${2:-.}" "${3:-gbk}" "${4:-utf-8}"
        ;;
    *)
        echo "现场运维工具箱 —— 用法:"
        echo ""
        echo "  bash ops_tools.sh check             系统健康检查"
        echo "  bash ops_tools.sh backup <库名>      备份MySQL数据库"
        echo "  bash ops_tools.sh grep <文件> <关键词> 搜索日志"
        echo "  bash ops_tools.sh ps <进程名>        查找进程"
        echo "  bash ops_tools.sh port <端口号>      检查端口"
        echo "  bash ops_tools.sh svc <动作> <服务>   服务管理"
        echo "  bash ops_tools.sh top               系统资源Top5"
        echo "  bash ops_tools.sh cron              定时任务模板"
        echo "  bash ops_tools.sh convert [目录]     文件编码转换(GBK→UTF8)"
        echo ""
        ;;
esac
