import {Response, type V4FetchHandler} from 'miniflare';
/** Only the model HTTP is controlled: standard Cordis tools execute in the actual facet. */
export function packageModel() {
  const observations: string[] = [];
  const event = (type: string, value: object) => `event: ${type}\ndata: ${JSON.stringify({type,...value})}\n\n`;
  const outbound: V4FetchHandler = async request => {
    const body = await request.json() as {messages: {role: string; content: unknown}[]; tools?: {name: string}[]};
    observations.push(JSON.stringify(body));
    const start = body.messages.findLastIndex(row => row.role === 'user' && Array.isArray(row.content) && row.content.some(block => block.type === 'text' && String(block.text).includes('SAVE_PACKAGE')));
    const called = body.messages.slice(start+1).some(row => row.role === 'assistant' && JSON.stringify(row.content).includes('package_save'));
    const tool = start >= 0 && !called && body.tools?.some(row => row.name === 'package_save');
    return new Response(event('message_start',{message:{usage:{input_tokens:10,output_tokens:0}}})
      +event('content_block_start',{index:0,content_block:tool?{type:'tool_use',id:crypto.randomUUID(),name:'package_save',input:{}}:{type:'text',text:''}})
      +event('content_block_delta',{index:0,delta:tool?{type:'input_json_delta',partial_json:'{}'}:{type:'text_delta',text:'PACKAGE_DONE'}})
      +event('content_block_stop',{index:0})+event('message_delta',{delta:{stop_reason:tool?'tool_use':'end_turn'},usage:{output_tokens:3}})+event('message_stop',{}),{headers:{'content-type':'text/event-stream'}});
  };
  return {outbound, observations};
}
