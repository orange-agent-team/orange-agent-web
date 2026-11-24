# 用户 Web静态开发包

使用 Node 22.23.2 与 Python 3.12。在此仓库根目录执行 `python3.12 scripts/package-static.py`。构建器将固定 Git 提交解包到两个空目录，分别按照 package-lock.json 离线安装依赖，执行原有测试和生产构建，比较完整归档后再启动真实 Chrome 验证解包结果。首次准备本仓库 npm 缓存时，可在 apps/web 下运行 `npm ci --ignore-scripts --no-audit --no-fund --registry https://registry.npmjs.org --cache ../../.local/npm-cache`。

发行目录为 `.local/static-distributions/`。按旁附回执校验压缩包 SHA-256。将解压后的 site 目录设为静态根，保留站点外的 metadata 和 manifest.json 供恢复核验。为站点启用独立 HTTPS origin，本机开发示例为 https://127.0.0.1:43122。

反向代理先将 /api/v1/ 前缀交给本应用对应的后端，保留 Origin、Cookie、Set-Cookie 和响应状态。API 错误直接传回。其他前端路由以 site/index.html 作为深链接入口，哈希命名的静态资产按原路径返回，缺失的静态资产返回 404。部署新版本时原子切换站点根，保留旧版本及其哈希资源供回滚。生产签名、域名和真实上线仍需独立验证。

归档验收仅验证真实浏览器能够装载独立静态包，并在身份服务不可用时进入受限登录界面。实际 OIDC、MFA 与授权业务流程的验证见对应服务联调记录。

### 大文件下载的对象存储源

图像下载会核对应用版本、长度、文件摘要和当前内容权限。包内的 `site/artifact-download.json` 默认使用同源平台下载，内容为 `{"version":1,"origin":null}`。

部署启用了版本化对象后端时，可在相同路径单独提供部署配置，例如 `{"version":1,"origin":"https://storage.example.invalid"}`。origin 必须与平台签发的 S3 URL 源完全一致。请把该源加入站点的 connect-src，并在私有桶的 CORS 配置中允许用户 Web 的实际源发起 GET。该文件只包含源地址，不含令牌、密钥和对象 URL。

浏览器向对象源发起 GET 时省略 Cookie、授权头和 Referer，拒绝重定向。收到完整字节并核对 SHA-256 后还会再检查一次平台上的内容权限，然后才保存文件。签名、配置、CORS 或授权失败时，用户可以重新核对版本并发起新的下载。

启用对象存储源后，文本输入、音频文件和图像校验页的文件可按原 upload_id 直传至暂存区。CORS 还需要允许当前 Web 源的 PUT 以及签名要求的请求头。浏览器根据实际文件自动设置 Content-Length，其他签名头按原值发送。原文件和平台身份不会作为 URL 参数传递。

上传中断或服务器回执丢失时，客户端先查询原记录的提供商版本，再决定是否确认。已写入的文件可继续确认；没有完整观测时，界面保留原 ID 供重试。只有平台返回已发布状态并校验内容后，图像才会显示校验结果。
