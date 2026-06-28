# Music Download X

基于自定义音源的纯前端高品质音乐搜索与下载工具，采用苹果液态玻璃风设计，并支持 Cloudflare Pages 部署。

## 📦 项目结构

- `/public`: 包含前端的 HTML, CSS, JavaScript 等静态文件资源。
- `/functions/api`: 包含 Cloudflare Pages Functions 接口（跨域代理、搜索解析、流式下载代理）。

## 🚀 本地开发与调试

1. 安装本地开发工具 (Wrangler)：
   ```bash
   npm install
   ```

2. 启动本地开发服务：
   ```bash
   npm run dev
   ```
   启动后，可在浏览器中打开 **[http://localhost:8788](http://localhost:8788)** 进行体验与调试。

## 🌐 部署上线 (Cloudflare Pages)

您可以通过 Cloudflare Pages 轻松免费托管该项目，只需点击部署按钮或运行部署脚本即可自动上线：
```bash
npm run deploy
```
