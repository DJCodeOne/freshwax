// src/lib/d1/comments.ts
// D1 operations for comments

import type { D1Database, D1Row } from './types';
import { log } from './types';

export interface D1Comment {
  id: string;
  item_id: string;
  item_type: 'release' | 'mix';
  user_id: string;
  user_name: string;
  avatar_url: string | null;
  comment: string | null;
  gif_url: string | null;
  approved: number;
  created_at: string;
}

// Get comments for an item (release or mix)
export async function d1GetComments(db: D1Database, itemId: string, itemType: 'release' | 'mix'): Promise<Record<string, unknown>[]> {
  try {
    const { results } = await db.prepare(
      `SELECT * FROM comments WHERE item_id = ? AND item_type = ? ORDER BY created_at DESC`
    ).bind(itemId, itemType).all();

    return (results || []).map((row) => {
      const r = row as D1Row;
      return {
        id: r.id,
        userId: r.user_id,
        userName: r.user_name,
        avatarUrl: r.avatar_url,
        comment: (r.comment as string) || '',
        gifUrl: r.gif_url,
        timestamp: r.created_at,
        createdAt: r.created_at,
        approved: r.approved === 1
      };
    });
  } catch (error: unknown) {
    log.error('[D1] Error getting comments:', error);
    return [];
  }
}

// Add a comment
export async function d1AddComment(db: D1Database, comment: {
  id: string;
  itemId: string;
  itemType: 'release' | 'mix';
  userId: string;
  userName: string;
  avatarUrl?: string;
  comment?: string;
  gifUrl?: string;
}): Promise<boolean> {
  try {
    await db.prepare(`
      INSERT INTO comments (id, item_id, item_type, user_id, user_name, avatar_url, comment, gif_url, approved, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).bind(
      comment.id,
      comment.itemId,
      comment.itemType,
      comment.userId,
      comment.userName,
      comment.avatarUrl || null,
      comment.comment || null,
      comment.gifUrl || null,
      new Date().toISOString()
    ).run();

    return true;
  } catch (error: unknown) {
    log.error('[D1] Error adding comment:', error);
    return false;
  }
}

// Get comment count for an item
export async function d1GetCommentCount(db: D1Database, itemId: string, itemType: 'release' | 'mix'): Promise<number> {
  try {
    const result = await db.prepare(
      `SELECT COUNT(*) as count FROM comments WHERE item_id = ? AND item_type = ?`
    ).bind(itemId, itemType).first();

    return (result as D1Row)?.count as number || 0;
  } catch (error: unknown) {
    log.error('[D1] Error getting comment count:', error);
    return 0;
  }
}
