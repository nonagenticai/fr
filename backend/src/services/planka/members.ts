import { encodePath, type PlankaHttp } from './http';
import type { User, BoardMembership, CardMembership, Single, Many, BoardDetail } from './types';

export interface BoardMembershipInput {
  boardId: string;
  userId: string;
  role?: 'editor' | 'viewer';
  canComment?: boolean;
}

export class MembersResource {
  constructor(private readonly http: PlankaHttp) {}

  // List all Planka users visible to the caller.
  async listUsers(): Promise<User[]> {
    const res = await this.http.request<Many<User>>('GET', '/api/users', {});
    return res.items;
  }

  // Get a user by id.
  async getUser(id: string): Promise<User> {
    const res = await this.http.request<Single<User>>('GET', `/api/users/${encodePath(id)}`, {});
    return res.item;
  }

  // Return the Planka user corresponding to this client's current credentials.
  // Planka accepts the literal `me` as an id on GET /api/users/{id}.
  async me(): Promise<User> {
    const res = await this.http.request<Single<User>>('GET', '/api/users/me', {});
    return res.item;
  }

  // Board memberships — who can see this board.
  // Planka has no dedicated list endpoint; pull from the board-detail included block.
  async listBoardMembers(boardId: string): Promise<BoardMembership[]> {
    const detail = await this.http.request<BoardDetail>(
      'GET',
      `/api/boards/${encodePath(boardId)}`,
      {},
    );
    return detail.included.boardMemberships ?? [];
  }

  async addBoardMember(input: BoardMembershipInput): Promise<BoardMembership> {
    const res = await this.http.request<Single<BoardMembership>>(
      'POST',
      `/api/boards/${encodePath(input.boardId)}/board-memberships`,
      {
        body: {
          userId: input.userId,
          role: input.role ?? 'editor',
          canComment: input.canComment ?? true,
        },
      },
    );
    return res.item;
  }

  async removeBoardMember(membershipId: string): Promise<void> {
    await this.http.request(
      'DELETE',
      `/api/board-memberships/${encodePath(membershipId)}`,
      {},
    );
  }

  // Card memberships — who is assigned to the card.
  async addCardMember(cardId: string, userId: string): Promise<CardMembership> {
    const res = await this.http.request<Single<CardMembership>>(
      'POST',
      `/api/cards/${encodePath(cardId)}/card-memberships`,
      { body: { userId } },
    );
    return res.item;
  }

  async removeCardMember(cardId: string, userId: string): Promise<void> {
    // Matrix-param shape: `/card-memberships/userId:<id>`. Encode only the id
    // portion — the literal `userId:` prefix must stay untouched.
    await this.http.request(
      'DELETE',
      `/api/cards/${encodePath(cardId)}/card-memberships/userId:${encodePath(userId)}`,
      {},
    );
  }

  // Project members — Planka exposes participants via GET /api/projects/:id
  // under `included.users`.
  async listProjectMembers(projectId: string): Promise<User[]> {
    const res = await this.http.request<{ included: { users?: User[] } }>(
      'GET',
      `/api/projects/${encodePath(projectId)}`,
      {},
    );
    return res.included.users ?? [];
  }
}
