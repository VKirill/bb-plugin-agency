import { defineRpcContract } from '@get-bb/plugin-sdk';
import { z } from 'zod';
export const documentInput = z.object({
 sessionId:z.string().uuid(), jobId:z.string().regex(/^AG-\d+$/),
 fileId:z.string().min(1).max(128),
 name:z.string().min(1).max(180).regex(/^[^/\\\x00-\x1f]+$/).refine(s=>s!=='.'&&s!=='..'),
 content:z.string().max(7*1024*1024),kind:z.enum(['text','image']),
}).strict();
export const documentHostContract=defineRpcContract({materialize:{input:documentInput,output:z.object({path:z.string()})}});
