import {
  SAFETY_CRITICAL_FIELDS,
  benchCapacityReport,
  collectDownstream,
  freezeBlockers,
  parseAmountEntries
} from '../src/safetyRules';
import type { ProcessStep } from '../src/safetyRules';

let failures = 0;
function check(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}\n    expected: ${e}\n    actual:   ${a}`);
  }
}

function makeStep(partial: Partial<ProcessStep> & { id: string }): ProcessStep {
  return {
    title: partial.id, purpose: '', materials: '', equipment: '', amount: '', duration: 10,
    hazards: [], controls: '', dependencies: [], safetyNote: '', expectedResult: '',
    status: 'confirmed', comments: [], ...partial
  };
}

// 与初始数据一致的六步流程
function seedSteps(): ProcessStep[] {
  return [
    makeStep({ id: 'step-1', amount: '乙醇 120 mL；去离子水 300 mL', hazards: ['易燃液体'], controls: 'x', safetyNote: 'x' }),
    makeStep({ id: 'step-2', amount: '循环液 800 mL', hazards: ['烫伤'], controls: 'x', safetyNote: 'x', dependencies: ['step-1'] }),
    makeStep({ id: 'step-3', amount: '催化剂 A 2.50 ± 0.02 g', hazards: ['粉尘吸入'], controls: 'x', safetyNote: 'x', dependencies: ['step-2'] }),
    makeStep({ id: 'step-4', amount: '每点样品约 1 mL，共 6 点', hazards: ['高温液体'], controls: 'x', safetyNote: 'x', dependencies: ['step-3'] }),
    makeStep({ id: 'step-5', amount: '降温目标 ≤ 30 ℃', hazards: ['烫伤'], controls: 'x', safetyNote: 'x', dependencies: ['step-4'] }),
    makeStep({ id: 'step-6', amount: '按实际产生量记录', hazards: ['废液混装'], controls: 'x', safetyNote: 'x', dependencies: ['step-5'] })
  ];
}

// 复刻 App.tsx 中 updateStep 的失效逻辑
function applyEdit(steps: ProcessStep[], id: string, field: keyof ProcessStep, value: unknown): { steps: ProcessStep[]; invalidated: string[]; critical: boolean } {
  const next: ProcessStep[] = JSON.parse(JSON.stringify(steps));
  const critical = SAFETY_CRITICAL_FIELDS.includes(field);
  const downstream = critical ? collectDownstream(next, id) : [];
  const invalidated: string[] = [];
  const step = next.find((item) => item.id === id)!;
  (step as unknown as Record<string, unknown>)[field] = value;
  if (critical) {
    if (step.status === 'confirmed') step.status = 'submitted';
    downstream.forEach((downId) => {
      const target = next.find((item) => item.id === downId)!;
      if (target.status === 'confirmed') {
        target.status = 'submitted';
        invalidated.push(target.id);
      }
    });
  }
  return { steps: next, invalidated, critical };
}

console.log('== 用量解析 ==');
check('乙醇 120 mL；去离子水 300 mL', parseAmountEntries('乙醇 120 mL；去离子水 300 mL'), [{ value: 120, base: 'mL' }, { value: 300, base: 'mL' }]);
check('催化剂 A 2.50 ± 0.02 g（取主值而非误差值）', parseAmountEntries('催化剂 A 2.50 ± 0.02 g'), [{ value: 2.5, base: 'g' }]);
check('降温目标 ≤ 30 ℃（温度不计入）', parseAmountEntries('降温目标 ≤ 30 ℃'), []);
check('按实际产生量记录（无数值）', parseAmountEntries('按实际产生量记录'), []);
check('盐酸 0.5 L 换算为 500 mL', parseAmountEntries('盐酸 0.5 L'), [{ value: 500, base: 'mL' }]);
check('氢氧化钠 1.2 kg 换算为 1200 g', parseAmountEntries('氢氧化钠 1.2 kg'), [{ value: 1200, base: 'g' }]);

console.log('== 台面容量 ==');
const seedReport = benchCapacityReport(seedSteps());
check('初始数据液体累计 1221 mL 未超限', seedReport.find((r) => r.base === 'mL')!.exceeded, false);
check('初始数据液体累计值', seedReport.find((r) => r.base === 'mL')!.used, 1221);
check('初始数据固体累计 2.5 g 未超限', seedReport.find((r) => r.base === 'g')!.exceeded, false);
const overSteps = seedSteps();
overSteps[1].amount = '循环液 1800 mL'; // 420 + 1800 + 1 = 2221 mL ≥ 2000 mL
const overReport = benchCapacityReport(overSteps);
const overLiquid = overReport.find((r) => r.base === 'mL')!;
check('循环液改为 1800 mL 后液体超限', overLiquid.exceeded, true);
check('超限步骤名单（含各自用量）', overLiquid.contributors.map((c) => `${c.id}:${c.amount}`), ['step-1:420', 'step-2:1800', 'step-4:1']);
const noHazardSteps = seedSteps();
noHazardSteps[1].hazards = [];
noHazardSteps[1].amount = '循环液 5000 mL';
check('无危险项的步骤不计入危险品累计', benchCapacityReport(noHazardSteps).find((r) => r.base === 'mL')!.used, 421);

console.log('== 依赖失效重算 ==');
const edit1 = applyEdit(seedSteps(), 'step-2', 'materials', '循环液（更换批次）');
check('改材料：step-2 自身退回待复核', edit1.steps[1].status, 'submitted');
check('改材料：传递下游全部退回', edit1.invalidated, ['step-3', 'step-4', 'step-5', 'step-6']);
check('改材料：上游 step-1 不受影响', edit1.steps[0].status, 'confirmed');
const edit2 = applyEdit(seedSteps(), 'step-1', 'amount', '乙醇 150 mL；去离子水 300 mL');
check('改用量：下游 2-6 全部退回', edit2.invalidated, ['step-2', 'step-3', 'step-4', 'step-5', 'step-6']);
const edit3 = applyEdit(seedSteps(), 'step-1', 'hazards', ['易燃液体', '挥发']);
check('改危险项：下游 2-6 全部退回', edit3.invalidated, ['step-2', 'step-3', 'step-4', 'step-5', 'step-6']);
const edit4 = applyEdit(seedSteps(), 'step-1', 'title', '核对试剂与实验区域（修订）');
check('只改名称：不触发重算，无退回', [edit4.critical, edit4.invalidated, edit4.steps.map((s) => s.status)], [false, [], ['confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed', 'confirmed']]);
const edit5 = applyEdit(seedSteps(), 'step-1', 'duration', 20);
check('只改时间：不触发重算，无退回', [edit5.critical, edit5.invalidated.length], [false, 0]);
const mixed = seedSteps();
mixed[2].status = 'submitted'; // step-3 尚未确认
mixed[4].status = 'draft';
const edit6 = applyEdit(mixed, 'step-1', 'materials', '无水乙醇、去离子水、丙酮');
check('仅已确认的下游被退回（step-2/4/6）', edit6.invalidated, ['step-2', 'step-4', 'step-6']);
check('非已确认下游保持原状态', [edit6.steps[2].status, edit6.steps[4].status], ['submitted', 'draft']);
const edit7 = applyEdit(seedSteps(), 'step-6', 'amount', '废液约 400 mL');
check('末步改动：自身退回且无下游', [edit7.steps[5].status, edit7.invalidated], ['submitted', []]);

console.log('== 冻结拦截 ==');
check('全部确认且容量正常：无拦截', freezeBlockers(seedSteps()), []);
const afterEdit = edit2.steps;
const blockers = freezeBlockers(afterEdit);
check('上游改动后冻结被拦截（含未确认步骤名单）', blockers.length === 1 && blockers[0].includes('6 个步骤未确认') && blockers[0].includes('step-2') && blockers[0].includes('step-6'), true);
const overConfirmed = seedSteps();
overConfirmed[1].amount = '循环液 1800 mL';
const capBlockers = freezeBlockers(overConfirmed);
check('容量超限拦截并指出超限步骤', capBlockers.length === 1 && capBlockers[0].includes('2221 mL') && capBlockers[0].includes('2000 mL') && capBlockers[0].includes('step-2'), true);
console.log('    拦截文案: ' + (capBlockers[0] ?? ''));
const missingSafety = seedSteps();
missingSafety[3].safetyNote = '';
check('安全缺口拦截', freezeBlockers(missingSafety).some((r) => r.includes('安全信息缺失')), true);

console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
