export { resolveJobCommentActor, selectCurrentAttempt } from "./actor-proof";
export { createJobComment } from "./service";
export type { JobCommentDeps, JobCommentProof } from "./service";
export {
  JOB_COMMENT_REGISTER_GLUE,
  bindJobCommentHandler,
  readCliThreadId,
} from "./register-glue";
