# Web产品、管理后台与技术架构

日期：2026-11-04。用户端E10与管理端E11分别位于独立Web/Admin仓库和独立来源；本文保留系统协作视图，Admin具体技术与权限以其独立项目文档为准。运行验证NOT_RUN。

## 产品与执行位置

| 层 | 职责 | 事实权威 |
|---|---|---|
| 用户SPA | 会话、任务、工作区、工具批准、成果、钱包与团队 | 显示E07/云Host已提交的状态，不自行决定费用或效果 |
| 管理SPA | 用户/节点/模型/资金/风控/发行的受保护运营入口 | 经Admin API提交领域命令和审批，不能直写数据库 |
| E07控制面 | Web会话、ACL、Run分配、预算/Job/资金、管理审批与审计 | PostgreSQL事务与持久事件 |
| E03云Host | Agent循环、工具策略、操作意图、恢复 | 通过E07 RunStore接口持久化云Run事实；不进入API进程执行工具 |
| 隔离工作区 | 授权文件/Git/受控进程、输入输出产物 | 固定Run/租户/执行租约；网络、时间、CPU/内存/磁盘有限额 |
| 推理Worker | 审核模型推理与GPU生命周期 | 与云工具执行池分开，仍不运行用户任意代码 |

浏览器通过E07创建CloudRun，E07授权云Host执行；云Host只在有效Run租约和持久授权下派发工具。GPU推理按原Job/Lease/预算路径调用。网页关闭不取消已接受的任务；到期/取消/撤权停止新效果，未决状态仍可查询。

## 主选技术

React＋TypeScript＋Vite作为SPA构建，React Router负责路由，TanStack Query管理服务端状态，Ant Design作为用户控制台及Admin Panel组件基线；临时交互状态使用React本地状态/reducer。不另起Node BFF：Web会话与CSRF校验放在Rust E07。

后续实现时固定版本、生成器和锁文件，并记录实际浏览器组合。该设计不是所有依赖已互相验证的声明。技术依据：[React构建说明](https://react.dev/learn/build-a-react-app-from-scratch)、[React Router](https://reactrouter.com/start/declarative/installation)、[TanStack Query](https://tanstack.com/query/latest/docs/framework/react/overview)、[Ant Design](https://ant.design/docs/react/introduce/)。

E10只维护用户应用package，E11在orange-agent-admin中独立维护管理应用package。共享组件通过固定版本发布，两个来源/会话/API权限独立；不能以资源包分开代替后端鉴权。

## 认证与接口

用户端访问用户来源下的`/api/v1`；管理端访问管理来源下的`/admin/v1`。反向代理可以到同一E07部署，但身份client/audience、会话cookie、允许来源与路由策略必须分别配置。

E07持有OIDC令牌，浏览器使用Secure、HttpOnly、host-only会话cookie。管理cookie名`__Host-orange-admin`，Path=/、SameSite=Lax；用户cookie独立。OIDC回调验证state/nonce和固定redirect URI；身份提供方的管理员MFA声明由服务端验证，不能信任前端勾选。

所有管理写操作需要有效CSRF token、精确Origin与当前平台权限；CORS禁止通配凭证。敏感响应Cache-Control: no-store，用户端Service Worker不能缓存管理响应。Token、支付密钥、供应商凭证不进入构建变量、浏览器localStorage或普通日志。

用户API和Admin API分别定义session/permission；任何角色必须由后端实时查验。管理端被撤权后停止新命令和敏感结果返回，已经派发的不可逆领域动作按原业务身份核对，不伪装回滚。

## 用户与管理功能分工

用户控制台管理自己的目标、批准、预算和资源；Admin Panel管理平台可运营状态。管理员可以按权限取消异常任务、停新分配或处理账务case，但不能以平台身份伪装用户批准Agent工具，也不能默认读取私人工作区或提示词。

完整Web Agent首发按原G3工具/模型/角色边界提供云端映射；浏览器工具、多Agent和无人值守仍按G4，Objective/企业按G5，多域/资源组按G6。管理后台展示对应功能状态，不越过原发布门槛。

## 调整与扩展

改变会话/审批/API时同步用户端、管理端和E07契约；改变云Host/沙箱时同步E03/E02和RunStore/执行租约；改变费用时同步Quote/预算/用户确认，不能只改管理表单。

React技术选择不改变Flutter桌面；用户浏览器操作本机Host需另立配对协议，当前默认不开放。Admin Panel不提供通用SQL控制台、任意服务器Shell或可查看全部凭证的调试入口。
