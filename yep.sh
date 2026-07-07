#!/bin/bash

# Yep Anywhere 项目管理脚本
# 可在 IDE 中直接点击运行按钮执行

set -e

# ==================== 配置区域 ====================
# 修改此处的 PORT 值会影响所有端口：
#   主服务端：PORT
#   维护服务端：PORT + 1
#   Vite dev：PORT + 2

PORT=3400

# 说明：此值会作为环境变量传递给 pnpm dev/start
# 项目代码会自动计算其他端口
# ================================================

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# 项目根目录
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$SCRIPT_DIR"

# 计算端口
MAIN_PORT=$PORT
MAINTENANCE_PORT=$((PORT + 1))
VITE_PORT=$((PORT + 2))
CODEX_BRIDGE_PORT=4510
CLAUDE_BRIDGE_PORT=4520

# LaunchAgent 服务名称
# 注意：此 label 名称来自原项目（yueyuan），保持不变以兼容已安装的 LaunchAgent
# 如需自定义，可通过环境变量 YEP_LAUNCHD_SERVER_LABEL 覆盖
LAUNCHD_SERVICE="${YEP_LAUNCHD_SERVER_LABEL:-com.yueyuan.yepanywhere.server}"

# 辅助函数
print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

print_header() {
    echo -e "\n${BLUE}===${NC} $1 ${BLUE}===${NC}\n"
}

# 检查端口是否被占用
check_port() {
    local port=$1
    if lsof -Pi :$port -sTCP:LISTEN -t >/dev/null 2>&1; then
        return 0  # 端口被占用
    else
        return 1  # 端口空闲
    fi
}

# 获取占用端口的进程信息
get_port_process() {
    local port=$1
    lsof -Pi :$port -sTCP:LISTEN -t 2>/dev/null || echo ""
}

# 查找进程树的根进程（pnpm/node 顶层进程）
find_process_tree_root() {
    local pid=$1
    local current_pid=$pid
    local root_pid=$pid

    # 向上追溯进程树，找到 pnpm 或独立的 node 进程
    while [ -n "$current_pid" ] && [ "$current_pid" != "1" ]; do
        local ppid=$(ps -o ppid= -p $current_pid 2>/dev/null | tr -d ' ')
        local cmd=$(ps -o command= -p $current_pid 2>/dev/null)

        # 如果找到 pnpm dev/start 或 scripts/dev.js，这就是根进程
        if echo "$cmd" | grep -qE "pnpm (dev|start)|scripts/dev.js"; then
            root_pid=$current_pid
            break
        fi

        # 如果父进程是 init (PID 1) 或不存在，当前进程就是根
        if [ -z "$ppid" ] || [ "$ppid" == "1" ]; then
            root_pid=$current_pid
            break
        fi

        root_pid=$current_pid
        current_pid=$ppid
    done

    echo "$root_pid"
}

# 停止进程树（包括所有子进程）
kill_process_tree() {
    local pid=$1
    local signal=${2:-TERM}

    # 获取所有子进程
    local children=$(pgrep -P $pid 2>/dev/null || true)

    # 递归停止所有子进程
    for child in $children; do
        kill_process_tree $child $signal
    done

    # 停止当前进程
    kill -$signal $pid 2>/dev/null || true
}

# 停止指定端口的服务
stop_service_by_port() {
    local port=$1
    local pid=$(get_port_process $port)

    if [ -z "$pid" ]; then
        return 0
    fi

    print_info "发现进程 PID: $pid 占用端口 $port"

    # 获取进程信息
    local process_info=$(ps -p $pid -o command= 2>/dev/null || echo "未知进程")
    print_info "进程: $process_info"

    # 查找进程树根节点
    local root_pid=$(find_process_tree_root $pid)
    if [ "$root_pid" != "$pid" ]; then
        local root_cmd=$(ps -p $root_pid -o command= 2>/dev/null || echo "未知")
        print_info "找到根进程 PID: $root_pid"
        print_info "根进程: $root_cmd"
        pid=$root_pid
    fi

    # 尝试优雅停止整个进程树
    print_info "停止进程树..."
    kill_process_tree $pid TERM

    # 等待最多5秒
    for i in {1..5}; do
        sleep 1
        if ! ps -p $pid > /dev/null 2>&1; then
            print_success "进程已停止"
            return 0
        fi
    done

    # 强制停止进程树
    print_warning "强制终止进程树..."
    kill_process_tree $pid KILL
    sleep 1

    if ! ps -p $pid > /dev/null 2>&1; then
        print_success "进程已停止"
        return 0
    else
        print_error "无法停止进程"
        return 1
    fi
}

# 检查 launchd 服务是否运行
check_launchd_service() {
    launchctl list | grep -q "$LAUNCHD_SERVICE" 2>/dev/null
}

# 停止 launchd 服务
stop_launchd_service() {
    if check_launchd_service; then
        print_info "检测到 launchd 服务正在运行，正在停止..."
        launchctl stop "$LAUNCHD_SERVICE" 2>/dev/null || true
        launchctl unload ~/Library/LaunchAgents/${LAUNCHD_SERVICE}.plist 2>/dev/null || true
        sleep 2
        if check_launchd_service; then
            print_warning "launchd 服务停止失败"
            return 1
        else
            print_success "launchd 服务已停止"
        fi
    fi
    return 0
}

# 启用 launchd 服务
start_launchd_service() {
    print_header "启用 launchd 开机自启"

    if check_launchd_service; then
        print_warning "launchd 服务已在运行"
        return 0
    fi

    local plist_file=~/Library/LaunchAgents/${LAUNCHD_SERVICE}.plist
    if [ ! -f "$plist_file" ]; then
        print_error "launchd 配置文件不存在: $plist_file"
        print_info "请先运行: pnpm launchd:install"
        return 1
    fi

    launchctl load "$plist_file"
    sleep 2

    if check_launchd_service; then
        print_success "launchd 服务已启动"
        print_info "服务将在开机时自动启动"
    else
        print_error "launchd 服务启动失败"
        return 1
    fi
}

# 停止所有服务
stop_all_services() {
    print_header "停止服务"

    # 先停止 launchd 服务（如果正在运行）
    stop_launchd_service

    print_info "停止主服务端 (端口 $MAIN_PORT)..."
    stop_service_by_port $MAIN_PORT

    print_info "停止维护服务端 (端口 $MAINTENANCE_PORT)..."
    stop_service_by_port $MAINTENANCE_PORT

    print_info "停止 Vite dev server (端口 $VITE_PORT)..."
    stop_service_by_port $VITE_PORT

    print_info "停止 Codex Bridge (端口 $CODEX_BRIDGE_PORT)..."
    stop_service_by_port $CODEX_BRIDGE_PORT

    print_info "停止 Claude Bridge (端口 $CLAUDE_BRIDGE_PORT)..."
    stop_service_by_port $CLAUDE_BRIDGE_PORT

    print_success "所有服务已停止"
}

# 检测运行模式（开发/生产）
detect_run_mode() {
    local pid=$1
    if [ -z "$pid" ]; then
        echo "未知"
        return
    fi

    # 检查进程命令行
    local cmd=$(ps -p $pid -o command= 2>/dev/null || echo "")

    # 检查是否包含开发模式特征
    if echo "$cmd" | grep -q "tsx\|--import tsx\|pnpm dev\|scripts/dev.js"; then
        echo "开发模式"
    # 检查是否包含生产模式特征
    elif echo "$cmd" | grep -q "dist/index.js\|pnpm start\|NODE_ENV=production"; then
        echo "生产模式"
    else
        echo "未知"
    fi
}

# 检查服务状态
check_status() {
    print_header "服务状态"

    # LaunchAgent 状态
    if check_launchd_service; then
        print_success "LaunchAgent (开机自启): 已启用"
    else
        print_warning "LaunchAgent (开机自启): 未启用"
    fi
    echo ""

    echo "端口占用情况:"
    echo ""

    # 主服务端
    if check_port $MAIN_PORT; then
        local pid=$(get_port_process $MAIN_PORT)
        local cmd=$(ps -p $pid -o command= 2>/dev/null || echo "未知")
        local mode=$(detect_run_mode $pid)
        print_success "主服务端 (端口 $MAIN_PORT): 运行中 [$mode]"
        echo "  PID: $pid"
        echo "  命令: $cmd"
    else
        print_warning "主服务端 (端口 $MAIN_PORT): 未运行"
    fi
    echo ""

    # 维护服务端
    if check_port $MAINTENANCE_PORT; then
        local pid=$(get_port_process $MAINTENANCE_PORT)
        local cmd=$(ps -p $pid -o command= 2>/dev/null || echo "未知")
        local mode=$(detect_run_mode $pid)
        print_success "维护服务端 (端口 $MAINTENANCE_PORT): 运行中 [$mode]"
        echo "  PID: $pid"
        echo "  命令: $cmd"
    else
        print_warning "维护服务端 (端口 $MAINTENANCE_PORT): 未运行"
    fi
    echo ""

    # Vite dev server
    if check_port $VITE_PORT; then
        local pid=$(get_port_process $VITE_PORT)
        local cmd=$(ps -p $pid -o command= 2>/dev/null || echo "未知")
        print_success "Vite dev server (端口 $VITE_PORT): 运行中"
        echo "  PID: $pid"
        echo "  命令: $cmd"
    else
        print_warning "Vite dev server (端口 $VITE_PORT): 未运行"
    fi
    echo ""

    # Codex Bridge
    if check_port $CODEX_BRIDGE_PORT; then
        local pid=$(get_port_process $CODEX_BRIDGE_PORT)
        local cmd=$(ps -p $pid -o command= 2>/dev/null || echo "未知")
        print_success "Codex Bridge (端口 $CODEX_BRIDGE_PORT): 运行中"
        echo "  PID: $pid"
        echo "  命令: $cmd"
    else
        print_warning "Codex Bridge (端口 $CODEX_BRIDGE_PORT): 未运行"
    fi
    echo ""

    # Claude Bridge
    if check_port $CLAUDE_BRIDGE_PORT; then
        local pid=$(get_port_process $CLAUDE_BRIDGE_PORT)
        local cmd=$(ps -p $pid -o command= 2>/dev/null || echo "未知")
        print_success "Claude Bridge (端口 $CLAUDE_BRIDGE_PORT): 运行中"
        echo "  PID: $pid"
        echo "  命令: $cmd"
    else
        print_warning "Claude Bridge (端口 $CLAUDE_BRIDGE_PORT): 未运行"
    fi

    # 日志文件位置
    echo ""
    print_info "日志文件:"
    echo "  开发日志: ~/.yep-anywhere/logs/server.log"
    echo "  生产日志: /private/tmp/yep-server.log"
}

# 启动开发模式
start_dev() {
    print_header "启动开发模式"

    # 先停止 launchd 服务（如果正在运行）
    stop_launchd_service

    # 检查端口冲突
    if check_port $MAIN_PORT; then
        print_error "端口 $MAIN_PORT 已被占用"
        local pid=$(get_port_process $MAIN_PORT)
        print_info "占用进程 PID: $pid"

        echo ""
        echo "1) 停止现有服务并重新启动"
        echo "2) 取消"
        echo ""
        read -p "请选择 (1-2): " -n 1 -r
        echo ""

        if [[ $REPLY == "1" ]]; then
            stop_all_services
            echo ""
        else
            print_error "启动取消"
            return 1
        fi
    fi

    cd "$PROJECT_ROOT"

    # 询问运行模式
    echo ""
    echo "选择运行模式:"
    echo "1) 前台运行 (终端关闭后服务停止，可看到实时日志)"
    echo "2) 后台运行 (终端关闭后服务继续运行)"
    echo ""
    read -p "请选择 (1-2，默认 1): " -n 1 -r
    echo ""
    echo ""

    local run_mode=${REPLY:-1}

    if [[ $run_mode == "2" ]]; then
        # 后台运行
        print_success "后台启动开发服务..."
        print_info "运行命令: PORT=$PORT pnpm dev"
        print_info "访问地址: http://localhost:$MAIN_PORT"
        print_info "日志文件: ~/.yep-anywhere/logs/dev-console.log"
        echo ""

        # 使用 nohup + env 后台运行，输出重定向到日志
        nohup env PORT=$PORT pnpm dev > ~/.yep-anywhere/logs/dev-console.log 2>&1 &
        local pid=$!

        # 等待服务启动
        sleep 3

        if ps -p $pid > /dev/null 2>&1; then
            print_success "服务已在后台启动 (PID: $pid)"
            print_info "查看日志: tail -f ~/.yep-anywhere/logs/server.log"
            print_info "停止服务: bash yep.sh stop"
        else
            print_error "服务启动失败，请检查日志: ~/.yep-anywhere/logs/dev-console.log"
            return 1
        fi
    else
        # 前台运行
        print_success "启动开发服务..."
        print_info "运行命令: PORT=$PORT pnpm dev"
        print_info "访问地址: http://localhost:$MAIN_PORT"
        print_info "按 Ctrl+C 停止服务"
        echo ""

        PORT=$PORT pnpm dev
    fi
}

# 启动生产模式
start_prod() {
    print_header "启动生产模式"

    # 先停止 launchd 服务（如果正在运行）
    stop_launchd_service

    # 检查端口冲突
    if check_port $MAIN_PORT; then
        print_error "端口 $MAIN_PORT 已被占用"
        local pid=$(get_port_process $MAIN_PORT)
        print_info "占用进程 PID: $pid"

        echo ""
        echo "1) 停止现有服务并重新启动"
        echo "2) 取消"
        echo ""
        read -p "请选择 (1-2): " -n 1 -r
        echo ""

        if [[ $REPLY == "1" ]]; then
            stop_all_services
            echo ""
        else
            print_error "启动取消"
            return 1
        fi
    fi

    cd "$PROJECT_ROOT"

    # 询问运行模式
    echo ""
    echo "选择运行模式:"
    echo "1) 前台运行 (终端关闭后服务停止，可看到实时日志)"
    echo "2) 后台运行 (终端关闭后服务继续运行)"
    echo ""
    read -p "请选择 (1-2，默认 2): " -n 1 -r
    echo ""
    echo ""

    local run_mode=${REPLY:-2}

    if [[ $run_mode == "2" ]]; then
        # 后台运行
        print_success "后台启动生产服务..."
        print_info "运行命令: PORT=$PORT pnpm start"
        print_info "访问地址: http://localhost:$MAIN_PORT"
        print_info "日志文件: /private/tmp/yep-server.log"
        echo ""

        # 使用 nohup + env 后台运行，输出重定向到日志
        nohup env PORT=$PORT pnpm start > /private/tmp/yep-server.log 2>&1 &
        local pid=$!

        # 等待服务启动
        sleep 3

        if ps -p $pid > /dev/null 2>&1; then
            print_success "服务已在后台启动 (PID: $pid)"
            print_info "查看日志: tail -f /private/tmp/yep-server.log"
            print_info "停止服务: bash yep.sh stop"
        else
            print_error "服务启动失败，请检查日志: /private/tmp/yep-server.log"
            return 1
        fi
    else
        # 前台运行
        print_success "启动生产服务..."
        print_info "运行命令: PORT=$PORT pnpm start"
        print_info "访问地址: http://localhost:$MAIN_PORT"
        print_info "按 Ctrl+C 停止服务"
        echo ""

        PORT=$PORT pnpm start
    fi
}

# 验证部署
verify_deployment() {
    local base_url="$1"

    print_info "验证部署..."

    # 等待服务完全启动
    sleep 2

    if node scripts/verify-deploy.mjs --base-url "$base_url" --build-info "$PROJECT_ROOT/dist/npm-package/build-info.json"; then
        print_success "部署验证通过：运行中的服务端和前端都已更新到最新构建"
        return 0
    else
        print_error "部署验证失败：运行中的服务或前端可能仍在使用旧代码"
        print_warning "请检查日志或手动验证"
        return 1
    fi
}

# 重启生产模式
restart_production() {
    stop_all_services
    sleep 2

    # 检查部署包是否存在
    local cli_path="$PROJECT_ROOT/dist/npm-package/dist/cli.js"
    if [[ ! -f "$cli_path" ]]; then
        print_error "部署包不存在: $cli_path"
        print_error "请先运行重构建"
        return 1
    fi

    # 确保 cli.js 有执行权限
    chmod +x "$cli_path"

    # 启动生产模式（使用构建好的部署包）
    print_info "后台启动生产服务（使用部署包）..."
    print_info "运行命令: node $cli_path --port $MAIN_PORT"

    nohup node "$cli_path" --port "$MAIN_PORT" > /private/tmp/yep-server.log 2>&1 &
    local pid=$!

    # 等待服务启动
    sleep 5

    if ps -p $pid > /dev/null 2>&1; then
        print_success "服务已在后台启动 (PID: $pid)"

        # 验证部署
        local base_url="http://127.0.0.1:${MAIN_PORT}"
        if verify_deployment "$base_url"; then
            print_success "生产模式重启完成并已验证"
        else
            print_warning "服务已启动，但验证未通过"
        fi
    else
        print_error "服务启动失败，请检查日志: /private/tmp/yep-server.log"
        return 1
    fi
}

# 重启开发模式
restart_development() {
    stop_all_services
    sleep 2

    # 启动开发模式（后台运行）
    print_info "后台启动开发服务..."
    nohup env PORT=$PORT pnpm dev > ~/.yep-anywhere/logs/dev-console.log 2>&1 &
    local pid=$!

    # 等待服务启动
    sleep 5

    if ps -p $pid > /dev/null 2>&1; then
        print_success "服务已在后台启动 (PID: $pid)"

        # 开发模式不需要验证 buildId（它使用源代码运行，buildId 总是 dev-xxx）
        # 只检查服务是否响应
        local base_url="http://127.0.0.1:${MAIN_PORT}"
        print_info "检查服务响应..."
        sleep 2

        if curl -fsS "${base_url}/api/version" >/dev/null 2>&1; then
            print_success "开发模式重启完成，服务正常响应"
        else
            print_warning "服务已启动，但未能访问 /api/version"
        fi
    else
        print_error "服务启动失败，请检查日志: ~/.yep-anywhere/logs/dev-console.log"
        return 1
    fi
}

# 重构建项目
rebuild() {
    print_header "重构建项目"

    cd "$PROJECT_ROOT"

    print_info "运行 Biome linter..."
    if pnpm lint; then
        print_success "Lint 通过"
    else
        print_error "Lint 失败"
        echo ""
        echo "1) 继续"
        echo "2) 停止"
        echo ""
        read -p "请选择 (1-2): " -n 1 -r
        echo ""
        if [[ $REPLY != "1" ]]; then
            return 1
        fi
    fi

    print_info "运行 TypeScript 类型检查..."
    if pnpm typecheck; then
        print_success "类型检查通过"
    else
        print_error "类型检查失败"
        return 1
    fi

    # 获取当前版本号
    local npm_version=$(node -p "require('./package.json').version")

    print_info "构建部署包 (版本: ${npm_version})..."
    if NPM_VERSION="$npm_version" pnpm build:bundle; then
        print_success "构建完成"

        # 显示构建信息
        if [[ -f "$PROJECT_ROOT/dist/npm-package/build-info.json" ]]; then
            local build_id=$(node -p "JSON.parse(require('fs').readFileSync('$PROJECT_ROOT/dist/npm-package/build-info.json', 'utf-8')).buildId")
            print_info "Build ID: $build_id"
        fi

        # 安装运行时依赖（参考 redeploy-server.sh 第249-251行）
        print_info "安装运行时依赖到 dist/npm-package ..."
        (cd dist/npm-package && npm install --omit=dev --no-audit --no-fund --silent)
        chmod +x dist/npm-package/dist/cli.js 2>/dev/null || true
        chmod +x dist/npm-package/node_modules/node-pty/prebuilds/*/spawn-helper 2>/dev/null || true
        print_success "运行时依赖安装完成"
    else
        print_error "构建失败"
        return 1
    fi

    print_success "重构建完成"
    echo ""
    print_warning "注意: 新代码已构建到 dist/npm-package/，但服务端进程还在运行旧代码"
    echo ""
    echo "是否重启服务端以应用新代码？"
    echo "1) 重启生产模式"
    echo "2) 重启开发模式"
    echo "3) 稍后手动重启"
    echo ""
    read -p "请选择 (1-3，默认 3): " -n 1 -r
    echo ""
    echo ""

    case ${REPLY:-3} in
        1)
            print_info "正在重启生产模式..."
            if restart_production; then
                echo ""
                print_success "服务端已重启并验证，请刷新浏览器查看新版本"
            else
                echo ""
                print_error "重启或验证失败，请手动检查"
            fi
            ;;
        2)
            print_info "正在重启开发模式..."
            if restart_development; then
                echo ""
                print_success "服务端已重启并验证，开发模式会自动刷新浏览器"
            else
                echo ""
                print_error "重启或验证失败，请手动检查"
            fi
            ;;
        3)
            print_info "跳过重启，你可以稍后运行:"
            echo "  - 选项 5) 重启生产模式"
            echo "  - 选项 4) 重启开发模式"
            ;;
    esac
}

# 显示帮助信息
show_help() {
    cat << EOF
${BLUE}Yep Anywhere 项目管理工具${NC}

用法:
  $0 [命令]

命令:
  start-dev       启动开发模式
  start-prod      启动生产模式
  stop            停止所有服务
  restart-dev     重启开发模式
  restart-prod    重启生产模式
  status          查看服务状态
  rebuild         重构建项目
  enable-launchd  启用 launchd 开机自启
  menu            显示交互式菜单 (默认)
  help            显示帮助信息

示例:
  $0              # 显示交互式菜单
  $0 start-dev    # 启动开发模式
  $0 status       # 查看状态

配置:
  修改脚本开头的 PORT 变量可更改默认端口
  当前配置: PORT=$PORT

EOF
}

# 交互式菜单
show_menu() {
    while true; do
        clear
        echo -e "${BLUE}╔════════════════════════════════════════╗${NC}"
        echo -e "${BLUE}║   Yep Anywhere 项目管理工具            ║${NC}"
        echo -e "${BLUE}╚════════════════════════════════════════╝${NC}"
        echo ""
        echo -e "  ${GREEN}1)${NC} 启动开发模式"
        echo -e "  ${GREEN}2)${NC} 启动生产模式"
        echo -e "  ${GREEN}3)${NC} 停止所有服务"
        echo -e "  ${GREEN}4)${NC} 重启开发模式"
        echo -e "  ${GREEN}5)${NC} 重启生产模式"
        echo -e "  ${GREEN}6)${NC} 查看服务状态"
        echo -e "  ${GREEN}7)${NC} 重构建项目"
        echo -e "  ${GREEN}8)${NC} 启用 launchd 开机自启"
        echo ""
        echo -e "  ${YELLOW}h)${NC} 帮助信息"
        echo -e "  ${RED}0)${NC} 退出"
        echo ""
        echo -e "${CYAN}当前端口配置: $MAIN_PORT / $MAINTENANCE_PORT / $VITE_PORT${NC}"
        echo ""
        read -p "请选择操作 (输入数字或字母后按回车): " choice

        case $choice in
            1)
                start_dev
                read -p "按回车继续..." -r
                ;;
            2)
                start_prod
                read -p "按回车继续..." -r
                ;;
            3)
                stop_all_services
                read -p "按回车继续..." -r
                ;;
            4)
                stop_all_services
                sleep 1
                start_dev
                read -p "按回车继续..." -r
                ;;
            5)
                stop_all_services
                sleep 1
                start_prod
                read -p "按回车继续..." -r
                ;;
            6)
                check_status
                read -p "按回车继续..." -r
                ;;
            7)
                rebuild
                read -p "按回车继续..." -r
                ;;
            8)
                start_launchd_service
                read -p "按回车继续..." -r
                ;;
            h|H)
                show_help
                read -p "按回车继续..." -r
                ;;
            0)
                print_info "退出管理工具"
                exit 0
                ;;
            *)
                print_error "无效选择"
                sleep 1
                ;;
        esac
    done
}

# 主函数
main() {
    local command="${1:-menu}"

    case $command in
        start-dev)
            start_dev
            ;;
        start-prod)
            start_prod
            ;;
        stop)
            stop_all_services
            ;;
        restart-dev)
            stop_all_services
            sleep 1
            start_dev
            ;;
        restart-prod)
            stop_all_services
            sleep 1
            start_prod
            ;;
        status)
            check_status
            ;;
        rebuild)
            rebuild
            ;;
        enable-launchd)
            start_launchd_service
            ;;
        menu)
            show_menu
            ;;
        help|-h|--help)
            show_help
            ;;
        *)
            print_error "未知命令: $command"
            echo ""
            show_help
            exit 1
            ;;
    esac
}

# 运行主函数
main "$@"
