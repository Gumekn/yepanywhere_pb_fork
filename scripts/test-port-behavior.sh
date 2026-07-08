#!/bin/bash

# 端口配置完整测试脚本
# 测试开发模式和生产模式的实际端口行为

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

print_test() {
    echo -e "\n${CYAN}=== $1 ===${NC}\n"
}

print_pass() {
    echo -e "${GREEN}✓${NC} $1"
}

print_fail() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${CYAN}ℹ${NC} $1"
}

# 清理函数
cleanup() {
    print_info "清理测试进程..."
    pkill -f "node.*cli.js" 2>/dev/null || true
    pkill -f "node.*index.js" 2>/dev/null || true
    sleep 2
}

# 检查端口是否被监听
check_port_listening() {
    local port=$1
    lsof -iTCP:$port -sTCP:LISTEN -n -P 2>/dev/null | grep -q "node"
}

# 获取实际监听的端口
get_listening_port() {
    lsof -iTCP -sTCP:LISTEN -n -P 2>/dev/null | grep node | grep -oE ":(3400|8022)" | sed 's/://' | head -1
}

cd "$(dirname "$0")/.."

print_test "测试 1: 生产模式（NODE_ENV=production，无端口参数）"
print_info "启动: NODE_ENV=production node dist/npm-package/dist/cli.js"

cleanup

# 后台启动生产模式
NODE_ENV=production node dist/npm-package/dist/cli.js > /tmp/test-prod.log 2>&1 &
PID=$!
sleep 5

# 检查监听的端口
if check_port_listening 8022; then
    print_pass "生产模式正确监听 8022 端口"
    TEST1_PASS=true
else
    print_fail "生产模式未监听 8022 端口"
    ACTUAL_PORT=$(get_listening_port)
    if [ -n "$ACTUAL_PORT" ]; then
        print_fail "实际监听端口: $ACTUAL_PORT （预期: 8022）"
    fi
    print_info "日志内容:"
    tail -20 /tmp/test-prod.log
    TEST1_PASS=false
fi

kill $PID 2>/dev/null || true
sleep 2

print_test "测试 2: 开发模式（未设置 NODE_ENV，无端口参数）"
print_info "启动: node dist/npm-package/dist/cli.js"

cleanup

# 后台启动开发模式
node dist/npm-package/dist/cli.js > /tmp/test-dev.log 2>&1 &
PID=$!
sleep 5

# 检查监听的端口
if check_port_listening 3400; then
    print_pass "开发模式正确监听 3400 端口"
    TEST2_PASS=true
else
    print_fail "开发模式未监听 3400 端口"
    ACTUAL_PORT=$(get_listening_port)
    if [ -n "$ACTUAL_PORT" ]; then
        print_fail "实际监听端口: $ACTUAL_PORT （预期: 3400）"
    fi
    print_info "日志内容:"
    tail -20 /tmp/test-dev.log
    TEST2_PASS=false
fi

kill $PID 2>/dev/null || true
sleep 2

print_test "测试 3: 生产模式（NODE_ENV=production + --port 9000）"
print_info "启动: NODE_ENV=production node dist/npm-package/dist/cli.js --port 9000"

cleanup

# 后台启动生产模式并指定端口
NODE_ENV=production node dist/npm-package/dist/cli.js --port 9000 > /tmp/test-prod-9000.log 2>&1 &
PID=$!
sleep 5

# 检查监听的端口
if check_port_listening 9000; then
    print_pass "手动指定端口正确监听 9000 端口"
    TEST3_PASS=true
else
    print_fail "未监听 9000 端口"
    ACTUAL_PORT=$(get_listening_port)
    if [ -n "$ACTUAL_PORT" ]; then
        print_fail "实际监听端口: $ACTUAL_PORT （预期: 9000）"
    fi
    print_info "日志内容:"
    tail -20 /tmp/test-prod-9000.log
    TEST3_PASS=false
fi

kill $PID 2>/dev/null || true
sleep 2

print_test "测试 4: 生产模式（NODE_ENV=production + PORT=9500）"
print_info "启动: NODE_ENV=production PORT=9500 node dist/npm-package/dist/cli.js"

cleanup

# 后台启动生产模式并设置 PORT 环境变量
NODE_ENV=production PORT=9500 node dist/npm-package/dist/cli.js > /tmp/test-prod-9500.log 2>&1 &
PID=$!
sleep 5

# 检查监听的端口
if check_port_listening 9500; then
    print_pass "PORT 环境变量正确监听 9500 端口"
    TEST4_PASS=true
else
    print_fail "未监听 9500 端口"
    ACTUAL_PORT=$(get_listening_port)
    if [ -n "$ACTUAL_PORT" ]; then
        print_fail "实际监听端口: $ACTUAL_PORT （预期: 9500）"
    fi
    print_info "日志内容:"
    tail -20 /tmp/test-prod-9500.log
    TEST4_PASS=false
fi

kill $PID 2>/dev/null || true

cleanup

# 总结
echo ""
echo "======================================"
echo "测试结果总结"
echo "======================================"
echo ""

if [ "$TEST1_PASS" = true ]; then
    print_pass "测试 1: 生产模式默认 8022"
else
    print_fail "测试 1: 生产模式默认 8022"
fi

if [ "$TEST2_PASS" = true ]; then
    print_pass "测试 2: 开发模式默认 3400"
else
    print_fail "测试 2: 开发模式默认 3400"
fi

if [ "$TEST3_PASS" = true ]; then
    print_pass "测试 3: --port 参数覆盖"
else
    print_fail "测试 3: --port 参数覆盖"
fi

if [ "$TEST4_PASS" = true ]; then
    print_pass "测试 4: PORT 环境变量覆盖"
else
    print_fail "测试 4: PORT 环境变量覆盖"
fi

echo ""

if [ "$TEST1_PASS" = true ] && [ "$TEST2_PASS" = true ] && [ "$TEST3_PASS" = true ] && [ "$TEST4_PASS" = true ]; then
    print_pass "所有测试通过！"
    exit 0
else
    print_fail "部分测试失败"
    exit 1
fi
