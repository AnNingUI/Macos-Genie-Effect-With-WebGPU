#!/usr/bin/env node

import { createServer } from 'http';
import { readFile } from 'fs/promises';
import { extname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const port = process.env.PORT || 8080;

const mimeTypes = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.ts': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm'
};

const server = createServer(async (req, res) => {
  try {
    let filePath = req.url === '/' ? '/index.html' : req.url;
    
    // 处理TypeScript文件
    if (filePath.endsWith('.ts')) {
      filePath = filePath.replace('.ts', '.js');
    }
    
    const fullPath = join(__dirname, filePath);
    const ext = extname(fullPath);
    const contentType = mimeTypes[ext] || 'text/plain';
    
    const data = await readFile(fullPath);
    
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cross-Origin-Embedder-Policy': 'require-corp',
      'Cross-Origin-Opener-Policy': 'same-origin'
    });
    
    res.end(data);
  } catch (error) {
    if (error.code === 'ENOENT') {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('File not found');
    } else {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Internal server error');
    }
  }
});

server.listen(port, () => {
  console.log(`🚀 Development server running at http://localhost:${port}`);
  console.log(`📁 Serving files from: ${__dirname}`);
  console.log(`🎯 Open http://localhost:${port} in your browser`);
  console.log(`⚠️  Make sure WebGPU is enabled in your browser`);
});

// 优雅关闭
process.on('SIGTERM', () => {
  console.log('Shutting down server...');
  server.close();
});