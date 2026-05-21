/**
 * Run: npx tsx plugin/webui/src/utils/toolResultClassify.test.ts
 */

import { strict as assert } from 'node:assert';
import { classifyToolResult } from './toolResultClassify';

{
    const p = classifyToolResult(
        'fs.read',
        { path: 'src/a.ts', range: { startLine: 1, endLine: 10 } },
        true,
        {
            path: 'src/a.ts',
            content: 'hello',
            totalLines: 1,
            bytes: 5,
            truncated: false,
            lang: 'TypeScript',
        },
    );
    assert.equal(p.kind, 'fs.read');
    assert.equal((p as { path: string }).path, 'src/a.ts');
    assert.equal((p as { content: string }).content, 'hello');
    console.log('✓ fs.read classify');
}

{
    const p = classifyToolResult('fs.list', { path: '.' }, true, {
        path: '.',
        entries: [{ name: 'a.ts', type: 'file', size: 10 }],
    });
    assert.equal(p.kind, 'fs.list');
    assert.equal((p as { entries: unknown[] }).entries.length, 1);
    console.log('✓ fs.list classify');
}

{
    const p = classifyToolResult('fs.read', { path: 'dir' }, true, {
        path: 'dir',
        isDirectory: true,
        entries: [{ name: 'x', type: 'file' }],
    });
    assert.equal(p.kind, 'fs.list');
    console.log('✓ fs.read directory → fs.list');
}
