#!/usr/bin/env node
/**
 * 测试脚本：验证 SessionPage 对不存在会话的错误处理
 *
 * 测试场景：
 * 1. 访问一个不存在的会话
 * 2. 验证页面不会崩溃
 * 3. 验证显示了友好的错误消息
 */

import http from 'node:http';

const BASE_URL = 'http://localhost:8022';
const TEST_PROJECT_ID = 'L1VzZXJzL3BiemhhbmcvRGVza3RvcC_ku6PnoIEveWVwYW55d2hlcmVfcGJfZm9yaw';
const TEST_SESSION_ID = 'b7a59918-586a-45e3-904e-969553882fd7';

async function testSessionNotFound() {
  console.log('测试：访问不存在的会话...');

  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}/api/projects/${TEST_PROJECT_ID}/sessions/${TEST_SESSION_ID}`;

    http.get(url, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);

          if (json.error === 'Session not found') {
            console.log('✓ API 正确返回 "Session not found" 错误');
            resolve(true);
          } else {
            console.error('✗ API 返回了意外的响应:', json);
            resolve(false);
          }
        } catch (err) {
          console.error('✗ 无法解析 API 响应:', err.message);
          resolve(false);
        }
      });
    }).on('error', (err) => {
      console.error('✗ HTTP 请求失败:', err.message);
      reject(err);
    });
  });
}

async function testHealthEndpoint() {
  console.log('测试：服务健康检查...');

  return new Promise((resolve, reject) => {
    http.get(`${BASE_URL}/api/health`, (res) => {
      if (res.statusCode === 200) {
        console.log('✓ 服务运行正常');
        resolve(true);
      } else {
        console.error('✗ 服务健康检查失败，状态码:', res.statusCode);
        resolve(false);
      }
    }).on('error', (err) => {
      console.error('✗ 无法连接到服务:', err.message);
      reject(err);
    });
  });
}

async function main() {
  console.log('='.repeat(60));
  console.log('SessionPage 错误处理测试');
  console.log('='.repeat(60));
  console.log();

  try {
    // 测试 1: 健康检查
    const healthOk = await testHealthEndpoint();
    if (!healthOk) {
      console.error('\n服务未运行或不健康，请先启动服务');
      process.exit(1);
    }

    console.log();

    // 测试 2: 不存在的会话
    const notFoundOk = await testSessionNotFound();

    console.log();
    console.log('='.repeat(60));

    if (healthOk && notFoundOk) {
      console.log('✓ 所有测试通过');
      console.log();
      console.log('手动测试：');
      console.log(`请在浏览器中打开以下链接，验证页面显示友好的错误消息而不是崩溃：`);
      console.log(`${BASE_URL}/projects/${TEST_PROJECT_ID}/sessions/${TEST_SESSION_ID}`);
      process.exit(0);
    } else {
      console.log('✗ 部分测试失败');
      process.exit(1);
    }
  } catch (err) {
    console.error('测试过程中发生错误:', err);
    process.exit(1);
  }
}

main();
