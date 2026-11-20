import { z } from 'zod';

/** Path parameters shared by the routes under a roadmap. */
export const roadmapParams = z.object({ roadmapId: z.string().min(1).max(100) });
export const projectParams = roadmapParams.extend({ projectId: z.string().min(1).max(100) });
