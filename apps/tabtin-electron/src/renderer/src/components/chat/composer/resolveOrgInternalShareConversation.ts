import { CONVERSATION_TYPE_DM } from '@/constants/tabchat'
import type { Conversation } from '@/services/tabchatApi'

export function findOrgInternalDirectConversation(params: {
  conversations: readonly Conversation[]
  organizationId: string
  peerUserId: string
}): string | null {
  const organizationId = params.organizationId.trim()
  const peerUserId = params.peerUserId.trim()
  if (!organizationId || !peerUserId) return null
  const match = params.conversations.find((conversation) => (
    conversation.type === CONVERSATION_TYPE_DM
    && conversation.organization_id === organizationId
    && conversation.dm_peer_user_id === peerUserId
  ))
  return match?.id ?? null
}

export async function resolveOrgInternalShareConversationId(params: {
  conversations: readonly Conversation[]
  organizationId: string
  peerUserId: string
  createDirect: (
    organizationId: string,
    peerUserId: string,
  ) => Promise<{ conversation_id: string }>
}): Promise<string> {
  const existing = findOrgInternalDirectConversation(params)
  if (existing) return existing
  const created = await params.createDirect(params.organizationId, params.peerUserId)
  const conversationId = created.conversation_id.trim()
  if (!conversationId) {
    throw new Error('组织内私聊未返回会话')
  }
  return conversationId
}

/** 跨组织共享（组织外好友）：外部私聊的对端是用户 id，不需要组织匹配。 */
export function findExternalDirectConversation(params: {
  conversations: readonly Conversation[]
  peerUserId: string
}): string | null {
  const peerUserId = params.peerUserId.trim()
  if (!peerUserId) return null
  const match = params.conversations.find((conversation) => (
    conversation.is_external === true
    && conversation.dm_peer_user_id === peerUserId
  ))
  return match?.id ?? null
}

/**
 * 跨组织共享的投递会话：优先复用已有外部私聊，没有则用外部联系人 id 建一条
 * （服务端 create_external_dm 自带「已有则复用」）。绝不能走组织内 createDM——
 * 那条会校验同组织成员，接收方是组织外好友时必报「接收人不是该组织成员」。
 */
export async function resolveExternalShareConversationId(params: {
  conversations: readonly Conversation[]
  organizationId: string
  externalContactId: string
  peerUserId: string
  createExternalDirect: (
    organizationId: string,
    externalContactId: string,
  ) => Promise<{ conversation_id: string }>
}): Promise<string> {
  const existing = findExternalDirectConversation({
    conversations: params.conversations,
    peerUserId: params.peerUserId,
  })
  if (existing) return existing
  const created = await params.createExternalDirect(
    params.organizationId,
    params.externalContactId,
  )
  const conversationId = created.conversation_id.trim()
  if (!conversationId) {
    throw new Error('跨组织私聊未返回会话')
  }
  return conversationId
}
