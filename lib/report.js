/**
 * perse-proof · lib/report.js
 *
 * B 面：向系统提示词注入「汇报契约」段（docs/SPEC.md §3.4）。
 * 写法依据 API-NOTES §4：`ctx.systemPrompt.section({name, order, text})`，
 * order 用 `getSectionOrder('TOOL_REPORT')`，拿不到退回字面量 2900。
 * 同名重复注册会抛错 ⇒ 判重（按错误文本识别）+ try/catch 兜住。
 */

import { serviceOf, errorText } from './util.js';

/** 段名（冻结，测试会断言）。 */
export const SECTION_NAME = 'proof:report-contract';

/** 兜底 order：API-NOTES §4.2 实测 `SECTION_ORDERS.TOOL_REPORT === 2900`（跨版本可能漂移）。 */
export const FALLBACK_ORDER = 2900;

/** 汇报契约正文（写死、中文、≤900 字，测试直接断言）。 */
const CONTRACT_TEXT = [
  '汇报契约（由 perse-proof 插件强制，面向用户的每次汇报都必须遵守）：',
  '',
  '1. 先给结论，再给细节。默认按「结论 / 证据 / 影响 / 下一步」四段写，除非用户另有要求。',
  '',
  '2. 面向用户的文字里不要出现没有解释的内部代号和自造方案名（例如 D3、S6a、U-1-A1、ADJ-5、WP8）。确需引用时，第一次出现必须写成「白话名称（代号）」，例如「主按钮（D8）」。',
  '',
  '3. 说「已完成 / 已验证 / 全部通过」时，必须能指到一个真实存在的文件，或一条真实执行过的命令。指不出来，就改写成「未验证 / 待验证」，并说明还差哪一步。',
  '',
  '4. 任何数字都要有出处（哪个文件、哪条命令、哪次输出）。两个来源的数字对不上时，先说明各自的口径，不要闷头二选一。',
  '',
  '5. 不要把子代理的内部汇报原文直接贴给用户：先翻译成白话——做了什么、依据是什么、结论是什么、还剩什么。',
].join('\n');

/**
 * @param {{ctx:unknown, config:object, logger?:object}} deps
 */
export function createReport({ ctx, config } = {}) {
  const enabled = config?.report?.enabled !== false;
  const configuredOrder = config?.report?.order;

  /** 实际使用的 order（install 后为数字）。 */
  let installedOrder = null;

  function text() {
    return CONTRACT_TEXT;
  }

  /**
   * 解析段 order：优先 API，其次配置，最后字面量。
   * @returns {number}
   */
  function resolveOrder() {
    const systemPrompt = serviceOf(ctx, 'systemPrompt');
    try {
      const fromApi = systemPrompt?.getSectionOrder?.('TOOL_REPORT');
      if (Number.isFinite(fromApi)) return fromApi;
    } catch (error) {
      console.log(`[perse-proof] 读取 TOOL_REPORT 段序号失败，改用兜底值：${errorText(error)}`);
    }
    const fromConfig = Number(configuredOrder);
    if (Number.isFinite(fromConfig)) return fromConfig;
    return FALLBACK_ORDER;
  }

  /**
   * 注册系统提示词段。
   * @returns {{ok:boolean, order:number|null, duplicate?:boolean, reason?:string}}
   */
  function install() {
    if (!enabled) {
      console.log('[perse-proof] 汇报契约段已关闭（report.enabled=false），不注册');
      return { ok: false, order: null, reason: 'disabled' };
    }
    const systemPrompt = serviceOf(ctx, 'systemPrompt');
    if (systemPrompt === undefined || typeof systemPrompt.section !== 'function') {
      console.log('[perse-proof] 缺少系统提示词能力，跳过汇报契约段（其余功能不受影响）');
      return { ok: false, order: null, reason: 'no-systemPrompt' };
    }
    const order = resolveOrder();
    installedOrder = order;
    try {
      systemPrompt.section({ name: SECTION_NAME, order, text: CONTRACT_TEXT });
      console.log(`[perse-proof] 已注册汇报契约段（order=${order}）`);
      return { ok: true, order };
    } catch (error) {
      const message = errorText(error);
      if (/already registered|已注册|duplicate/i.test(message)) {
        console.log(`[perse-proof] 汇报契约段已存在（order=${order}），跳过重复注册`);
        return { ok: true, order, duplicate: true };
      }
      console.log(`[perse-proof] 注册汇报契约段失败：${message}`);
      return { ok: false, order, reason: message };
    }
  }

  return { install, text, resolveOrder, get order() { return installedOrder; } };
}
