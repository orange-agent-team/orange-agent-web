# Orange Agent Web

组织更新（2026-11-04）：E10只负责用户控制台与完整Web Agent。Admin已独立为E11 orange-agent-admin；管理专属文档与契约快照已迁入该目录，本仓库旧入口仅保留导航。

日期：2026-11-04。用户Web实现NOT_STARTED、运行NOT_RUN；当前只有文档，没有应用代码或Git初始化。

E10是独立用户Web应用。Admin独立构建/部署/版本/会话，两个仓库可按固定版本复用UI和契约；四仓库11工程，不共用管理cookie或源码path依赖。

## 文档入口

- [Web架构与技术基线](docs/architecture.md)：用户端、云Host、管理端及会话边界。
- [Admin Panel功能与权限](../orange-agent-admin/docs/admin-panel.md)：七种平台角色、功能模块、批准和执行。
- [管理端验收与后续扩展](../orange-agent-admin/docs/admin-acceptance.md)：阶段切片、失败场景和发布门槛。
- [管理接口消费说明](../orange-agent-admin/docs/contracts/README.md)：服务端契约的只读副本与版本规则。

完整Web Agent使用平台托管隔离工作区，不依赖用户桌面在线。Agent Runtime源码归服务端仓库，桌面和云Host复用同一内核。首版云工作区在硬配额内暂不单独收费；模型请求仍走统一预算、Quote与账本。

用户组织的owner/admin不自动成为平台管理员。管理端不授予模型、工具、第三方插件或普通用户会话访问特权API的能力。所有真实业务、安全与身份验证仍需后续实现和试验。
