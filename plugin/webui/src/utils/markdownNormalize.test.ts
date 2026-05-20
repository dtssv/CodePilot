import { describe, expect, it } from 'vitest';
import { normalizeMarkdownForDisplay } from './markdownNormalize';

describe('normalizeMarkdownForDisplay', () => {
    it('inserts space after heading hashes', () => {
        expect(normalizeMarkdownForDisplay('##分析')).toBe('## 分析');
    });

    it('separates glued heading from prior sentence', () => {
        const out = normalizeMarkdownForDisplay('完成。## 下一步');
        expect(out).toContain('完成。');
        expect(out).toContain('## 下一步');
        expect(out).toMatch(/完成。\n\n## 下一步/);
    });

    it('fixes numbered list without space', () => {
        expect(normalizeMarkdownForDisplay('1.第一项')).toBe('1. 第一项');
    });

    it('renumbers repeated 1. list lines', () => {
        const in_ = '风险：\n\n1.第一项。\n1.第二项。\n1.第三项。';
        const out = normalizeMarkdownForDisplay(in_);
        expect(out).toMatch(/1\.\s*第一项/);
        expect(out).toMatch(/2\.\s*第二项/);
        expect(out).toMatch(/3\.\s*第三项/);
    });

    it('splits glued Chinese step after dash', () => {
        const out = normalizeMarkdownForDisplay('目录（如果不存在）。-第五步：写入 lc。');
        expect(out).toContain('第五步：');
        expect(out).not.toMatch(/。-第五步/);
    });

    it('strips # # before ordered list', () => {
        const out = normalizeMarkdownForDisplay('# # 1. 列出目录\n# # 2. 读取文件');
        expect(out).toBe('1. 列出目录\n2. 读取文件');
    });

    it('converts ## 1. lines to plain list', () => {
        const out = normalizeMarkdownForDisplay('## 1. 第一步\n## 2. 第二步');
        expect(out).not.toContain('##');
        expect(out).toMatch(/1\.\s*第一步/);
        expect(out).toMatch(/2\.\s*第二步/);
    });
});
