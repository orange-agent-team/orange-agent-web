import {describe,expect,it} from 'vitest';
import {projectText} from '../src/api/text-transfer';

describe('local text transfer policy',()=>{
  it('keeps an unapproved draft local',()=>{
    expect(()=>projectText('private text','local','')).toThrow('LOCAL_ONLY');
    expect(projectText('private text','original','private')).toEqual({text:'private text',replacements:0});
  });
  it('uses the longest literal and never interprets regular expressions or replaces inserted markers',()=>{
    const result=projectText('客户 A.B 和 A，请联系 A.B','redacted','A\r\nA.B\n[已遮盖]\nA.B');
    expect(result).toEqual({text:'客户 [已遮盖] 和 [已遮盖]，请联系 [已遮盖]',replacements:3});
    expect(projectText('x🍊X','redacted','🍊\nX')).toEqual({text:'x[已遮盖][已遮盖]',replacements:2});
  });
  it('refuses invalid rule limits and reports unmatched literals accurately',()=>{
    expect(()=>projectText('a','redacted','\n')).toThrow('INVALID_REDACTION_RULES');
    expect(()=>projectText('a','redacted','x'.repeat(257))).toThrow('INVALID_REDACTION_RULES');
    expect(()=>projectText('a','redacted',Array.from({length:33},(_,n)=>String(n)).join('\n'))).toThrow('INVALID_REDACTION_RULES');
    expect(projectText('Name','redacted','name')).toEqual({text:'Name',replacements:0});
  });
});
