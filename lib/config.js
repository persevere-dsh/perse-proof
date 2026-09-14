/**
 * perse-proof · 配置
 *
 * 手写合并与校验（不引入 schemastery：本插件零依赖）。
 * 硬规则：**resolveConfig 绝不抛错** —— 看不懂的配置只降级为默认值并记一条中文告警。
 */

/** 默认配置（SPEC §4：默认值即推荐值）。 */
export const DEFAULTS = {
  report: { enabled: true, order: 2900, maxGatesPerTurn: 1 },
  jargon: { enabled: true, minCodenameCount: 2, extraPatterns: [] },
  claims: {
    enabled: true,
    gateOnCompletionClaim: true,
    strictCommandEvidence: true,
    allowUnmatchedCommands: false,
  },
  criteria: { enabled: true, driftDetect: true, requireAmendReason: true, normalizeVolatile: true },
  ledger: { enabled: true, todoDropDetect: true, writeAmplifyThreshold: 8 },
  budget: { enabled: false, noProgressRounds: 3, dispatchBudgetCheck: true, tokenAlerts: false },
};

/** 配置段的显示名（告警文本里给人看，不出现内部字段名）。 */
const SECTION_LABELS = {
  report: '汇报契约',
  jargon: '代号闸门',
  claims: '声明核对',
  criteria: '判据冻结',
  ledger: '台账',
  budget: '成本观测',
};

/** 配置项的显示名。 */
const KEY_LABELS = {
  enabled: '开关',
  order: '插入位置',
  maxGatesPerTurn: '每轮最多干预次数',
  minCodenameCount: '触发代号闸门的最少代号数',
  extraPatterns: '额外代号样式',
  gateOnCompletionClaim: '完成声明闸门',
  strictCommandEvidence: '命令证据严格核对',
  allowUnmatchedCommands: '允许找不到匹配的命令记录',
  driftDetect: '判据漂移检测',
  requireAmendReason: '改判据必须写原因',
  normalizeVolatile: '摘要忽略易变量',
  todoDropDetect: '待办丢项检测',
  writeAmplifyThreshold: '同一文件重写多少次就告警',
  noProgressRounds: '连续几轮没进展就告警',
  dispatchBudgetCheck: '派发预算核对',
  tokenAlerts: '用量告警',
};

/** 每段里允许出现的配置项及其类型。 */
const SCHEMA = {
  report: { enabled: 'boolean', order: 'integer', maxGatesPerTurn: 'integer' },
  jargon: { enabled: 'boolean', minCodenameCount: 'integer', extraPatterns: 'stringArray' },
  claims: {
    enabled: 'boolean',
    gateOnCompletionClaim: 'boolean',
    strictCommandEvidence: 'boolean',
    allowUnmatchedCommands: 'boolean',
  },
  criteria: {
    enabled: 'boolean',
    driftDetect: 'boolean',
    requireAmendReason: 'boolean',
    normalizeVolatile: 'boolean',
  },
  ledger: { enabled: 'boolean', todoDropDetect: 'boolean', writeAmplifyThreshold: 'integer' },
  budget: {
    enabled: 'boolean',
    noProgressRounds: 'integer',
    dispatchBudgetCheck: 'boolean',
    tokenAlerts: 'boolean',
  },
};

/** 整数上下限（防止配出把模型逼疯的值）。 */
const RANGES = {
  report: { order: [0, 100000], maxGatesPerTurn: [0, 20] },
  jargon: { minCodenameCount: [1, 100] },
  ledger: { writeAmplifyThreshold: [1, 10000] },
  budget: { noProgressRounds: [1, 1000] },
};

const label = (section, key) => `「${SECTION_LABELS[section] ?? section} · ${KEY_LABELS[key] ?? key}」`;
const sectionLabel = (section) => `「${SECTION_LABELS[section] ?? section}」`;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function typeText(type) {
  return type === 'boolean' ? '是/否' : type === 'integer' ? '整数' : '一组文字';
}

/**
 * 合并并校验配置。
 * @param {unknown} raw 用户配置（可为 undefined / null / 非对象）
 * @returns {{config: object, warnings: string[]}}
 */
export function resolveConfig(raw) {
  const config = clone(DEFAULTS);
  const warnings = [];

  if (raw === undefined || raw === null) return { config, warnings };
  if (!isPlainObject(raw)) {
    warnings.push('配置整体看不懂（应该是一段「段名 → 设置」的结构），已全部改用默认值。');
    return { config, warnings };
  }

  for (const [section, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(SCHEMA, section)) {
      warnings.push(`配置里有一段用不上的内容（${sectionLabel(section)}），已忽略。`);
      continue;
    }
    if (value === undefined) continue;
    if (!isPlainObject(value)) {
      warnings.push(`${sectionLabel(section)}整段看不懂（应该是一组设置），已改用默认值。`);
      continue;
    }
    for (const [key, rawValue] of Object.entries(value)) {
      const expected = SCHEMA[section][key];
      if (!expected) {
        warnings.push(`配置里有一个用不上的设置（${sectionLabel(section)}里的 ${key}），已忽略。`);
        continue;
      }
      if (rawValue === undefined) continue;

      if (expected === 'stringArray') {
        const list = Array.isArray(rawValue) ? rawValue : typeof rawValue === 'string' ? [rawValue] : null;
        const cleaned = list
          ? list.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim())
          : null;
        if (cleaned === null) {
          warnings.push(
            `${label(section, key)}看不懂（期望是${typeText(expected)}），已改用默认值。`,
          );
          continue;
        }
        config[section][key] = cleaned;
        continue;
      }

      if (expected === 'boolean') {
        if (typeof rawValue !== 'boolean') {
          warnings.push(`${label(section, key)}看不懂（期望是是/否），已改用默认值 ${config[section][key]}。`);
          continue;
        }
        config[section][key] = rawValue;
        continue;
      }

      // integer
      if (typeof rawValue !== 'number' || !Number.isFinite(rawValue) || !Number.isInteger(rawValue)) {
        warnings.push(`${label(section, key)}看不懂（期望是整数），已改用默认值 ${config[section][key]}。`);
        continue;
      }
      const range = RANGES[section] && RANGES[section][key];
      let next = rawValue;
      if (range) {
        if (next < range[0]) next = range[0];
        if (next > range[1]) next = range[1];
        if (next !== rawValue) {
          warnings.push(
            `${label(section, key)}超出了合适范围，已收到 ${next}（原来填的是 ${rawValue}）。`,
          );
        }
      }
      config[section][key] = next;
    }
  }

  return { config, warnings };
}
