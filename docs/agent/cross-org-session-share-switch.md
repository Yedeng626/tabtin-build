# 跨组织（跨部门）会话共享开关 `allow_cross_org_share`

适用：TabTin Community 自托管（224 实例 `/root/TabTin` 栈，PG 容器 `tabtin-community-postgres-1`）。

## 1. 开关在哪

组织级 JSONB 字段：`tabtinspace_organization.settings->>'allow_cross_org_share'`。

- **无需 migration**：settings 是现成 JSONB 列，加键即生效（服务端每读一次现查）。
- 判定代码：`apps/tabtin_django/apps/chat/conversation/services/session_share_service.py`
  的 `organization_allows_cross_org_share()`；投递侧第二次判定在
  `session_share_card_service._resolve_django_direct_conversation()`。
- **默认语义（2026-09-20 起）**：键缺失或 `settings` 为空 → **放开**；只有显式写
  `false` 才关闭；organization_id 为空或组织不存在 → 拒绝（保守）。
  在此之前是「缺失 = 关闭」，所以历史行为是关闭，靠 SQL 逐组织打开。

## 2. 第二道门槛（放不放开都要过）

跨组织接收人除开关外，还必须是**发起人的外部联系人且关系为 friend**
（`tabchat_external_contact`，方向 owner→peer）。否则仍返回 400「接收人不是该组织成员」。
所以「开关打开」≠「任意组织的人都能被分享」。

另外「交给同事继续（转交/续接）」要求接收方是本组织成员，跨组织只支持共享（参与）。

## 3. 只读核对

```bash
docker exec tabtin-community-postgres-1 psql -U tabtin_init -d tabtin -c "
SELECT name,
       settings->>'allow_cross_org_share' AS switch,
       CASE
         WHEN settings ? 'allow_cross_org_share'
              AND settings->>'allow_cross_org_share' = 'false' THEN '关闭（显式 false）'
         ELSE '放开（默认）'
       END AS effective
FROM tabtinspace_organization
ORDER BY created_at;"
```

生效值也可以不查库、直接问运行中的容器（绕过 HTTP，结果是代码真实判定）：

```bash
docker exec tabtin-community-django-1 python -c "
import django; django.setup()
from apps.chat.conversation.services import session_share_service as s
print(s.organization_allows_cross_org_share('<organization_id>'))"
```

## 4. 调整开关的 SQL

**单个组织打开**（保留其它 settings 键）：

```sql
UPDATE tabtinspace_organization
   SET settings = coalesce(settings, '{}'::jsonb) || '{"allow_cross_org_share": true}'::jsonb
 WHERE id = '<organization_id>';
```

**单个组织关闭**（显式 false，默认放开语义下这是唯一能关的方式）：

```sql
UPDATE tabtinspace_organization
   SET settings = coalesce(settings, '{}'::jsonb) || '{"allow_cross_org_share": false}'::jsonb
 WHERE id = '<organization_id>';
```

**全部组织打开 / 关闭**（去掉 `WHERE` 即可；自托管单公司场景常用）：

```sql
-- 打开
UPDATE tabtinspace_organization
   SET settings = coalesce(settings, '{}'::jsonb) || '{"allow_cross_org_share": true}'::jsonb;

-- 关闭
UPDATE tabtinspace_organization
   SET settings = coalesce(settings, '{}'::jsonb) || '{"allow_cross_org_share": false}'::jsonb;
```

**回滚成「继承默认」**（把键删掉，不再显式表态）：

```sql
UPDATE tabtinspace_organization
   SET settings = settings - 'allow_cross_org_share'
 WHERE id = '<organization_id>';
```

一行式（容器内执行，注意 `-U tabtin_init` 是超级用户，容器内 trust 免密）：

```bash
docker exec tabtin-community-postgres-1 psql -U tabtin_init -d tabtin -c \
  "UPDATE tabtinspace_organization SET settings = coalesce(settings,'{}'::jsonb) || '{\"allow_cross_org_share\": true}'::jsonb WHERE id = '<organization_id>';"
```

> psql 里字符串字面量用单引号；上面的 `\"` 只是 shell 双引号内的转义。别把 `null` 当字符串写
> （写成 `"null"` 会被判为显式值，不是「未配置」）。

## 5. 改完怎么验证

1. 读回值（第 3 节第一条 SQL），`effective` 应为「放开（默认）」或「关闭（显式 false）」。
2. 用真实链路测一次：把 A 组织的一个任务共享给 B 组织的 friend 外部联系人，
   `POST /api/chat/session-shares` 应 200 并在双方私聊出现 `card.type=session_share`
   （客户端：Agent 窗「共享任务」或与该好友私聊的「+ → 共享任务」）。
3. 反面用例：给非 friend 的组织外用户共享 → 仍 400「接收人不是该组织成员」（预期，别当回归）。

## 6. 与「默认放开」代码改动的关系

- 2026-09-20：`organization_allows_cross_org_share()` 已改为默认放开（本地两棵树 + 224 镜像
  `tabtin/community-django:local`，镜像 ID 记于会话记录；回滚镜像 tag `pre-crossorg-20260920`，
  源码备份 `/root/TabTin/session_share_service.py.bak-20260920`）。
- 因为代码默认放开，**新组织自动放开**，不必再逐组织写 SQL；本文件第 4 节的 SQL 用于
  ① 显式关闭某个组织；② 回滚代码到旧版后仍要放开的组织；③ 只想调整数据、不动镜像的场合。
- 只改 SQL、不改代码，也能让**存量**组织立刻放开；两者互不冲突（SQL 显式 true 在两种代码下都放开）。

## 7. 客户端候选名单（跨组织可选项从哪来）

Agent 窗「共享任务」对话框的接收人来自两处（2026-09-20 起）：

- 本组织成员：`GET /api/context/organizations/{orgId}/members`
- 其他组织联系人：`GET /api/im/external-contacts?organization_id=...`（只取 `relationship=friend`）

接收人是组织外好友时：投递会话走外部私聊（已有则复用，否则 `POST /api/im/conversations/dm`
带 `external_contact_id` 建一条），且不提供「交给同事继续」。
