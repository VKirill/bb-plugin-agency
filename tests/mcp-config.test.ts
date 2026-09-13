import { describe, expect, it } from 'vitest';
import { parseMcpImport, mcpExample } from '../src/app/prototype/mcp-config';
const doc = (config:unknown) => JSON.stringify({mcpServers:{tools:config}});
describe('MCP profile import boundary',()=>{
  it('imports remote and local examples without expanding references',()=>{
    expect(parseMcpImport(mcpExample())[0]).toMatchObject({name:'research-tools',enabled:true,config:{headers:{Authorization:'Bearer ${MCP_TOKEN}'}}});
    expect(parseMcpImport(mcpExample(true))[0].config).toMatchObject({command:'node',env:{API_KEY:'${MY_API_KEY}'}});
  });
  it('accepts multiple named transports',()=>{
    expect(parseMcpImport(JSON.stringify({mcpServers:{one:{url:'https://example.com/mcp'},two:{type:'sse',url:'http://localhost:3000/sse'},three:{command:'node',args:[]}}}))).toHaveLength(3);
  });
  it('refuses conflicts without overwriting another configuration',()=>{
    expect(()=>parseMcpImport(doc({command:'node'}),['TOOLS'])).toThrow('Имя MCP');
    expect(()=>parseMcpImport('{"mcpServers":{"one":{"command":"node"},"ONE":{"command":"node"}}}')).toThrow('Имя MCP');
  });
  it.each([{}, {command:'node',url:'https://example.com'}, {command:'node',args:'--help'}, {url:'invalid'}, {url:'file:///tmp/mcp'}, {url:'https://user:pass@example.com'}, {url:'https://example.com?token=secret'}, {command:'node',unknown:true}, {command:'node',env:{KEY:'example-plaintext'}}, {url:'https://example.com',headers:{Authorization:'example-plaintext'}}])('rejects unsupported/unsafe shape %j',config=>{
    expect(()=>parseMcpImport(doc(config))).toThrow();
  });
  it('rejects malformed, empty and oversized inputs with bounded errors',()=>{
    for(const value of ['{','{"mcpServers":{}}',' '.repeat(65537)]) expect(()=>parseMcpImport(value)).toThrow();
  });
  it('does not echo raw credentials into validation errors',()=>{
    try {parseMcpImport(doc({url:'https://example.com',headers:{Authorization:'example-private-value'}}));throw new Error('Unexpected success');}
    catch(error){expect(String(error)).not.toContain('example-private-value');}
  });
});
