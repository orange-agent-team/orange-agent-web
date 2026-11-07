# 用户契约固定快照

本目录原有的Admin OpenAPI、JSON Schema和示例已归入[orange-agent-admin的契约目录](../../../orange-agent-admin/docs/contracts/README.md)。权威源仍由服务端E02维护。

用户Web不再维护管理接口消费副本。当前用户接口0.1.0已新增在本目录：

最新消费快照0.2.0固定到服务端已提交版本`b76218e3b28048af0ef27ea0b04d83724ab04039`，包含原用户身份契约与新增个人账户契约。构建验证来源提交格式及每个本地文件的SHA，不读取相邻工作树。

- [OpenAPI](user.openapi.json)：6个路径、8个开发候选操作，覆盖用户登录/回调、会话查询/退出/自身退出上下文、组织创建/列表/详情。
- [JSON Schema](user.schema.json)：独立用户会话、按成员主体绑定的组织投影、创建请求和错误。
- [摘要清单](snapshot.json)：服务端源路径及逐文件SHA-256；构建核对本地快照，运行时不读取相邻仓库源码。
- [个人账户OpenAPI](account.openapi.json)与[Schema](account.schema.json)：当前会话归属的钱包、个人预算创建/详情/分页；金额为精确微积分字符串，创建预算不充值。

组织角色是owner/admin/member/billing/viewer，不能解读成平台角色；组织列表的user_id与每项member_user_id必须匹配当前用户。版本字段以十进制字符串传输。退出上下文只提供当前cookie对应的CSRF用于减少自身访问权限，不授予组织或管理权限。

更新流程：服务端修改并核对契约，执行`export-user-contracts.py --web-repo <本仓库>`复制准确字节，更新消费者，再通过构建和真实联调后分别提交。尚未宣称完整Run/Host/模型/预算/支付契约已由用户应用接入。
