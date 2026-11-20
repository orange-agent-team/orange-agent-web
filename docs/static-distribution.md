# 用户 Web静态开发包

使用 Node 22.23.2 与 Python 3.12。在此仓库根目录执行 `python3.12 scripts/package-static.py`。构建器将固定 Git 提交解包到两个空目录，分别按照 package-lock.json 离线安装依赖，执行原有测试和生产构建，比较完整归档后再启动真实 Chrome 验证解包结果。首次准备本仓库 npm 缓存时，可在 apps/web 下运行 `npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org --cache ../../.local/npm-cache`。

发行目录为 `.local/static-distributions/`。按旁附回执校验压缩包 SHA-256。将解压后的 site 目录设为静态根，保留站点外的 metadata 和 manifest.json 供恢复核验。为站点启用独立 HTTPS origin，本机开发示例为 https://127.0.0.1:43122。

反向代理先将 /api/v1/ 前缀交给本应用对应的后端，保留 Origin、Cookie、Set-Cookie 和响应状态。API 错误直接传回。其他前端路由以 site/index.html 作为深链接入口，哈希命名的静态资产按原路径返回，缺失的静态资产返回 404。部署新版本时原子切换站点根，保留旧版本及其哈希资源供回滚。生产签名、域名和真实上线仍需独立验证。

归档验收仅验证真实浏览器能够装载独立静态包，并在身份服务不可用时进入受限登录界面。实际 OIDC、MFA 与授权业务流程的验证见对应服务联调记录。
