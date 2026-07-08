#!/usr/bin/env node
/**
 * 验证端口配置是否符合第一性原理：
 * - 开发模式默认 3400
 * - 生产模式默认 8022
 * - 手动指定端口可以覆盖默认值
 */

import { loadConfig } from "../packages/server/dist/config.js";

const tests = [
  {
    name: "开发模式默认端口",
    env: { NODE_ENV: "development" },
    expected: { port: 3400, vitePort: 3402 },
  },
  {
    name: "生产模式默认端口",
    env: { NODE_ENV: "production" },
    expected: { port: 8022, vitePort: 8024 },
  },
  {
    name: "开发模式手动指定端口",
    env: { NODE_ENV: "development", PORT: "5000" },
    expected: { port: 5000, vitePort: 5002 },
  },
  {
    name: "生产模式手动指定端口",
    env: { NODE_ENV: "production", PORT: "9000" },
    expected: { port: 9000, vitePort: 9002 },
  },
  {
    name: "未设置 NODE_ENV（默认开发模式）",
    env: {},
    expected: { port: 3400, vitePort: 3402 },
  },
];

let passed = 0;
let failed = 0;

console.log("验证端口配置...\n");

for (const test of tests) {
  // 设置环境变量
  const originalEnv = { ...process.env };
  for (const [key, value] of Object.entries(test.env)) {
    process.env[key] = value;
  }

  // 删除未设置的环境变量
  if (!test.env.NODE_ENV) {
    process.env.NODE_ENV = undefined;
  }
  if (!test.env.PORT) {
    process.env.PORT = undefined;
  }

  try {
    const config = loadConfig();

    const portMatch = config.port === test.expected.port;
    const vitePortMatch = config.vitePort === test.expected.vitePort;

    if (portMatch && vitePortMatch) {
      console.log(`✓ ${test.name}`);
      console.log(`  port: ${config.port}, vitePort: ${config.vitePort}`);
      passed++;
    } else {
      console.log(`✗ ${test.name}`);
      console.log(
        `  预期: port=${test.expected.port}, vitePort=${test.expected.vitePort}`,
      );
      console.log(`  实际: port=${config.port}, vitePort=${config.vitePort}`);
      failed++;
    }
  } catch (error) {
    console.log(`✗ ${test.name}`);
    console.log(`  错误: ${error.message}`);
    failed++;
  } finally {
    // 恢复环境变量
    process.env = originalEnv;
  }

  console.log("");
}

console.log(`结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
