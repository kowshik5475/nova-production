import { supabase } from './client'
import type { Conversation } from '@/app/types'

// Thread CRUD runs client-side against the SECURITY DEFINER RPCs declared in
// the chat_conversations migration. nova-chat deliberately performs zero table
// writes (asserted by phase13), so message persistence stays in finalize and
// thread management stays here.

type ConversationRow = {
  conversation_id: string
  title: string
  created_at: string
  last_message_at: string | null
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.conversation_id,
    title: row.title,
    created_at: row.created_at,
    last_message_at: row.last_message_at ?? row.created_at,
  }
}

export async function listConversations(limit = 50): Promise<Conversation[]> {
  if (!supabase) return []
  const { data, error } = await supabase.rpc('get_chat_conversations', { p_limit: limit })
  if (error) throw error
  return ((data ?? []) as ConversationRow[]).map(toConversation)
}

export async function createConversation(title?: string): Promise<Conversation> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.rpc('create_chat_conversation', {
    p_title: title ?? null,
  })
  if (error) throw error
  const row = (data as ConversationRow[] | null)?.[0]
  if (!row) throw new Error('Conversation could not be created')
  return toConversation(row)
}

export async function renameConversation(id: string, title: string): Promise<Conversation> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { data, error } = await supabase.rpc('rename_chat_conversation', {
    p_conversation_id: id,
    p_title: title,
  })
  if (error) throw error
  const row = (data as ConversationRow[] | null)?.[0]
  if (!row) throw new Error('Conversation could not be renamed')
  return toConversation(row)
}

export async function deleteConversation(id: string): Promise<void> {
  if (!supabase) throw new Error('Supabase is not configured')
  const { error } = await supabase.rpc('delete_chat_conversation', {
    p_conversation_id: id,
  })
  if (error) throw error
}
