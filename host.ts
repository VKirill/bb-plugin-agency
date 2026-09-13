import { experimental_defineHostEntry } from '@get-bb/plugin-sdk/host';
import { documentHostContract } from './src/shared/document-contract';
import { materializeDocument } from './src/server/runtime/document-files';
export default experimental_defineHostEntry({contract:documentHostContract,handlers:{
 materialize:(input,context)=>materializeDocument(input,context.experimental_paths.dataDir,context.signal),
}});
