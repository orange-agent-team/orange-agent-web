# 用户契约固定快照

本目录原有的Admin OpenAPI、JSON Schema和示例已归入[orange-agent-admin的契约目录](../../../orange-agent-admin/docs/contracts/README.md)。权威源仍由服务端E02维护。

用户Web不再维护管理接口消费副本。当前用户接口0.1.0已新增在本目录：

最新消费快照0.2.0固定到服务端已提交版本`b76218e3b28048af0ef27ea0b04d83724ab04039`，包含原用户身份契约与新增个人账户契约。构建验证来源提交格式及每个本地文件的SHA，不读取相邻工作树。

模型任务增量快照0.3.0进一步固定到`bd896b70b598f45f22beae5ec2cc7977fec915da`，共八份文件；包含[对象/Job接口](artifacts.openapi.json)、[对象/Job schema](artifacts.schema.json)、[文本报价接口](pricing.openapi.json)和[报价schema](pricing.schema.json)。0.2.0为上一个已完成账户切片的历史版本。

当前撤回增量快照0.4.0固定`9dcab2dab1d4007bf9437d4b8165d86153b19945`，加入按原Invocation撤回的0.1.5对象契约。必须区分prevented回执与已有Job的取消状态；此前快照保留为历史版本说明。

- [OpenAPI](user.openapi.json)：6个路径、8个开发候选操作，覆盖用户登录/回调、会话查询/退出/自身退出上下文、组织创建/列表/详情。
- [JSON Schema](user.schema.json)：独立用户会话、按成员主体绑定的组织投影、创建请求和错误。
- [摘要清单](snapshot.json)：服务端源路径及逐文件SHA-256；构建核对本地快照，运行时不读取相邻仓库源码。
- [个人账户OpenAPI](account.openapi.json)与[Schema](account.schema.json)：当前会话归属的钱包、个人预算创建/详情/分页；金额为精确微积分字符串，创建预算不充值。

组织角色是owner/admin/member/billing/viewer，不能解读成平台角色；组织列表的user_id与每项member_user_id必须匹配当前用户。版本字段以十进制字符串传输。退出上下文只提供当前cookie对应的CSRF用于减少自身访问权限，不授予组织或管理权限。

更新流程：服务端修改并核对契约，执行`export-user-contracts.py --web-repo <本仓库>`复制准确字节，更新消费者，再通过构建和真实联调后分别提交。尚未宣称完整Run/Host/模型/预算/支付契约已由用户应用接入。

测试充值与退款快照覆盖原币最小单位、购买微积分、原单历史、可退上限、退款申请与查询。用户界面在恢复时重新读取当前账户下的业务编号，并在确认状态后更新显示。[冻结快照](snapshot.json)

团队治理快照可按登录身份检查邀请、成员和预算。所有者与管理员使用独立的组织编号和当前策略版本；成员只在自己的会话中领取邀请并查看获准额度。[团队治理契约](team-governance.openapi.json)

## 设备注册

个人账户可从积分与预算页进入设备注册，组织所有者和管理员从团队页进入。设备使用 `orange-worker prepare-enrollment-handoff` 导出公开 JSON。浏览器仅在用户确认后发送公开 CSR 和兑换令牌的摘要。请求编号同时作为幂等键。页面重开时按原编号读取授权状态。授权窗口、证书准备和设备兑换分别显示。撤销已兑换的授权会停用相应设备凭据。

客户端采用固定提交的 CSR JSON Schema、用户错误类型和设备注册 OpenAPI。仅明确的 ENROLLMENT_NOT_FOUND 响应允许发起新授权。组件按当前会话、所有者和请求号隔离状态。会话存储仅保存请求编号。公开交接文件与服务端核对时始终绑定同一公钥摘要和 CSR 摘要。[接口快照](worker-enrollment.openapi.json) · [CSR 格式](worker-certificate-request.schema.json) · [版本与摘要](snapshot.json)
