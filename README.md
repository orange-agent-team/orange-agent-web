# Orange Agent Web

最新模型任务增量：已接通[个人文本任务](docs/model-tasks.md)的上传、报价、确认、原请求恢复、取消和结果。22客户端、4 Chrome替身、实际Chrome/API/Worker/固定CPU模型/独立计量/PG结算/清理及关联回归通过。会话/价格/登记准入夹具与真实组件分别记录；完整Web Agent、支付和未知提交的确定性撤回仍未完成。

最新增量：已加入[个人积分与预算页面](docs/personal-account.md)，固定消费服务端`b76218e`的契约。正式源码11项客户端、3项Chrome替身、4项真实OIDC/用户流程及关联真库检查通过。完整模型任务和Web Agent仍未完成。

组织更新（2026-11-04）：E10只负责用户控制台与完整Web Agent。Admin已独立为E11 orange-agent-admin；管理专属文档与契约快照已迁入该目录，本仓库旧入口仅保留导航。

日期：2026-11-04。已有React/TypeScript用户应用、独立OIDC登录/会话、组织创建与列表；已运行真实本机Keycloak/PostgreSQL/HTTPS/Chrome验证。完整Web Agent、云工作区、模型市场和支付仍待实现，不是完整候选发布版。

E10是独立用户Web应用。Admin独立构建/部署/版本/会话，两个仓库可按固定版本复用UI和契约；四仓库11工程，不共用管理cookie或源码path依赖。

## 文档入口

- [Web架构与技术基线](docs/architecture.md)：用户端、云Host、管理端及会话边界。
- [当前实现与运行](docs/implementation-status.md)：精确构建、真实身份联调与剩余范围。
- [个人积分与预算](docs/personal-account.md)：精确金额、原创建意图恢复、当前身份和独立验证边界。
- [用户接口快照](docs/contracts/README.md)：服务端权威契约与客户端固定版本。
- [Admin Panel功能与权限](../orange-agent-admin/docs/admin-panel.md)：七种平台角色、功能模块、批准和执行。
- [管理端验收与后续扩展](../orange-agent-admin/docs/admin-acceptance.md)：阶段切片、失败场景和发布门槛。
- [管理接口消费说明](../orange-agent-admin/docs/contracts/README.md)：服务端契约的只读副本与版本规则。

完整Web Agent使用平台托管隔离工作区，不依赖用户桌面在线。Agent Runtime源码归服务端仓库，桌面和云Host复用同一内核。首版云工作区在硬配额内暂不单独收费；模型请求仍走统一预算、Quote与账本。

用户组织的owner/admin不自动成为平台管理员。管理端不授予模型、工具、第三方插件或普通用户会话访问特权API的能力。当前本地身份/组织证据不能替代生产身份认证、完整业务、安全或目标平台验证。

任务取消使用所查看状态的版本。遇到陈旧版本时，个人和团队页面重新查询状态，只有用户再次选择取消才发出新请求。响应丢失时，已保存的原始幂等键和版本保持配对；旧服务未提供版本和以前保存的纯幂等键仍按旧协议处理。

个人与团队作业页面通过同源 WebSocket 接收持久事件元数据。新连接重建授权状态，断开时保留 HTTP 查询兜底。代理需要转发升级请求并保留页面 Origin；不需要在 URL 中放入令牌。账单金额以授权状态查询为准。
