export type StepStatus = 'draft' | 'submitted' | 'confirmed' | 'returned';

export interface ReviewComment {
  id: string;
  author: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface ProcessStep {
  id: string;
  title: string;
  purpose: string;
  materials: string;
  equipment: string;
  amount: string;
  duration: number;
  hazards: string[];
  controls: string;
  dependencies: string[];
  safetyNote: string;
  expectedResult: string;
  status: StepStatus;
  comments: ReviewComment[];
}

export interface CapacityContributor {
  id: string;
  title: string;
  amount: number;
}

export interface CapacityReport {
  base: 'mL' | 'g';
  label: string;
  limit: number;
  unitLabel: string;
  used: number;
  exceeded: boolean;
  contributors: CapacityContributor[];
}

// 仅名称与预计时间不影响下游安全结论；其余内容字段变更都会让本步骤及传递下游的确认结论失效
export const SAFETY_CRITICAL_FIELDS: (keyof ProcessStep)[] = [
  'purpose', 'materials', 'equipment', 'amount', 'hazards', 'controls', 'safetyNote', 'expectedResult', 'dependencies'
];

export const STEP_FIELD_LABELS: Partial<Record<keyof ProcessStep, string>> = {
  title: '名称', purpose: '目的', materials: '材料', equipment: '设备', amount: '用量',
  duration: '预计时间', hazards: '危险项', controls: '控制措施', safetyNote: '安全说明',
  expectedResult: '预期结果', dependencies: '依赖关系'
};

// 台面容量上限：同一实验内存在危险项的步骤，其危险品用量按单位类别累计
export const BENCH_CAPACITY: { base: 'mL' | 'g'; label: string; limit: number; unitLabel: string }[] = [
  { base: 'mL', label: '危险液体累计量', limit: 2000, unitLabel: 'mL' },
  { base: 'g', label: '危险固体累计量', limit: 500, unitLabel: 'g' }
];

export function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

export function collectDownstream(steps: ProcessStep[], sourceId: string | null): string[] {
  if (!sourceId) return [];
  const result = new Set<string>();
  const visit = (id: string) => {
    steps.filter((step) => step.dependencies.includes(id)).forEach((step) => {
      if (result.has(step.id)) return;
      result.add(step.id);
      visit(step.id);
    });
  };
  visit(sourceId);
  return [...result];
}

function normalizeUnit(unit: string): { base: 'mL' | 'g'; factor: number } | null {
  const value = unit.toLowerCase();
  if (value === 'ml' || value === '毫升') return { base: 'mL', factor: 1 };
  if (value === 'l' || value === '升') return { base: 'mL', factor: 1000 };
  if (value === 'µl' || value === 'μl' || value === '微升') return { base: 'mL', factor: 0.001 };
  if (value === 'kg' || value === '千克') return { base: 'g', factor: 1000 };
  if (value === 'mg' || value === '毫克') return { base: 'g', factor: 0.001 };
  if (value === 'g' || value === '克') return { base: 'g', factor: 1 };
  return null;
}

// 从用量文本中逐条解析“数值 + 单位”，换算到 mL / g 基准单位；无法识别的条目忽略
export function parseAmountEntries(amount: string): { value: number; base: 'mL' | 'g' }[] {
  const results: { value: number; base: 'mL' | 'g' }[] = [];
  amount.split(/[；;，,\n、]+/).forEach((entry) => {
    const numMatch = entry.match(/\d+(?:\.\d+)?/);
    if (!numMatch || numMatch.index === undefined) return;
    const rest = entry.slice(numMatch.index + numMatch[0].length);
    const unitMatch = rest.match(/微升|毫升|毫克|千克|µL|μL|mL|kg|mg|升|克|L|g(?![A-Za-zµμ])/i);
    if (!unitMatch) return;
    const normalized = normalizeUnit(unitMatch[0]);
    if (!normalized) return;
    results.push({ value: Number(numMatch[0]) * normalized.factor, base: normalized.base });
  });
  return results;
}

export function benchCapacityReport(steps: ProcessStep[]): CapacityReport[] {
  return BENCH_CAPACITY.map((category) => {
    const contributors: CapacityContributor[] = [];
    steps.forEach((step) => {
      if (!step.hazards.length) return;
      const amount = parseAmountEntries(step.amount)
        .filter((entry) => entry.base === category.base)
        .reduce((sum, entry) => sum + entry.value, 0);
      if (amount > 0) contributors.push({ id: step.id, title: step.title, amount });
    });
    const used = contributors.reduce((sum, item) => sum + item.amount, 0);
    return { ...category, used, exceeded: used >= category.limit, contributors };
  });
}

export function formatAmount(value: number, unit: string): string {
  return `${Number(value.toFixed(2))} ${unit}`;
}

export function freezeBlockers(steps: ProcessStep[]): string[] {
  const reasons: string[] = [];
  const unconfirmed = steps.filter((step) => step.status !== 'confirmed');
  if (unconfirmed.length) {
    reasons.push(`${unconfirmed.length} 个步骤未确认：${unconfirmed.map((step) => step.title).join('、')}`);
  }
  const missing = steps.filter(hasMissingSafety);
  if (missing.length) {
    reasons.push(`安全信息缺失：${missing.map((step) => step.title).join('、')}`);
  }
  benchCapacityReport(steps).filter((report) => report.exceeded).forEach((report) => {
    reasons.push(`${report.label} ${formatAmount(report.used, report.unitLabel)} 已触到台面容量上限 ${report.limit} ${report.unitLabel}，超限步骤：${report.contributors.map((item) => `${item.title}（${formatAmount(item.amount, report.unitLabel)}）`).join('、')}`);
  });
  return reasons;
}
