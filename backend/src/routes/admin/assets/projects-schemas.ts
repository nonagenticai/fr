// The PATCH /api/admin/assets/projects/:id body schema, moved verbatim out of ./projects.ts
// (fr-agui P4c part 2) so the capability declaration describes the SAME body (why `status` is
// the only key, and why 'archived' is refused: the note above its use in ./projects.ts).
// Side-effect free: zod only.
import { z } from 'zod';

export const PatchProjectSchema = z
  .object({
    status: z.enum(['submitted', 'active']).optional(),
  })
  .strict();
