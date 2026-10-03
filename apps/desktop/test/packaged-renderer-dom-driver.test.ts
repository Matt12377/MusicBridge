import assert from 'node:assert/strict'
import test from 'node:test'
import vm from 'node:vm'
import { PACKAGED_RENDERER_FIXTURE, packagedRendererDomExpression } from '../src/main/packaged-renderer-dom-driver.js'

function controlledDom(options: { duplicate?: boolean; disabled?: boolean } = {}) {
  const events: { label: string; type: string; value: string; isTrusted: boolean }[] = [], controls = new Map<string, Input>()
  let saved = 0
  class Element {
    textContent = ''; disabled = false
    getClientRects() { return [{}] }
    scrollIntoView() {}
    matches(selector: string) { return selector === ':disabled' && this.disabled }
    querySelector(_selector: string): any { return null }
    querySelectorAll(_selector: string): any[] { return [] }
  }
  class Input extends Element {
    value = ''; readOnly = false
    constructor(public label: string) { super(); controls.set(label, this) }
    dispatchEvent(event: { type: string; isTrusted: boolean }) { events.push({ label: this.label, type: event.type, value: this.value, isTrusted: event.isTrusted }); return true }
  }
  class Select extends Input {
    options: { value: string }[]
    constructor(label: string, values: string[]) { super(label); this.options = values.map(value => ({ value })) }
  }
  class Label extends Element {
    childNodes: { nodeType: number; textContent: string }[]
    constructor(public label: string, public control: Input) { super(); this.childNodes = [{ nodeType: 3, textContent: label }] }
    querySelectorAll(selector: string) { return selector === 'input,select' ? [this.control] : [] }
  }
  class Event { isTrusted = false; constructor(public type: string, _options?: unknown) {} }
  const labels = [
    ...['品牌', '型号', '版次 / 包装版本', '年份', '时长（分钟）', '未开封空白', '已拆空白', '旧录音待登记', '未分类'].map(name => new Label(name, new Input(name))),
    new Label('介质', new Select('介质', ['cassette', 'dat'])), new Label('磁带类型', new Select('磁带类型', ['unknown', 'I', 'II', 'III', 'IV'])), new Label('版次确认', new Select('版次确认', ['verified', 'unidentified', 'candidate'])),
  ]
  if (options.duplicate) labels.push(new Label('品牌', new Input('第二品牌')))
  const save = Object.assign(new Element(), { textContent: '保存库存', disabled: !!options.disabled, click() { saved++ } })
  const dialog = Object.assign(new Element(), { querySelectorAll(selector: string) { return selector === 'label' ? labels : selector === 'button' ? [save] : [] } })
  const document = { readyState: 'complete', querySelector(selector: string) { return selector.startsWith('dialog[') ? dialog : null }, querySelectorAll(selector: string) { return selector.startsWith('dialog[') ? [dialog] : [] } }
  const context = vm.createContext({ document, location: { href: 'musicbridge://app/index.html' }, Node: { TEXT_NODE: 3 }, HTMLInputElement: Input, HTMLSelectElement: Select, InputEvent: Event, Event, getComputedStyle: () => ({ visibility: 'visible', display: 'block' }), setTimeout })
  return { context, events, controls, saved: () => saved }
}

test('固定入库表达式操作原输入与submit控件，表单值经过input/change且仅点击一次', async () => {
  const dom = controlledDom()
  const snapshot = await vm.runInContext(packagedRendererDomExpression('receive-save', 0), dom.context)
  assert.equal(dom.saved(), 1); assert.equal(snapshot.frameUrl, 'musicbridge://app/index.html')
  assert.equal(dom.controls.get('品牌')?.value, PACKAGED_RENDERER_FIXTURE[0]!.model.brand)
  assert.equal(dom.controls.get('型号')?.value, PACKAGED_RENDERER_FIXTURE[0]!.model.name)
  assert.equal(dom.controls.get('已拆空白')?.value, '1')
  for (const control of dom.controls.values()) {
    const observed = dom.events.filter(event => event.label === control.label)
    assert.deepEqual(observed.map(event => event.type), ['input', 'change'])
    assert.ok(observed.every(event => event.isTrusted === false))
  }
})

test('缺少唯一控件或disabled提交立即拒绝，不补发写入、不改走API', async () => {
  for (const options of [{ duplicate: true }, { disabled: true }]) {
    const dom = controlledDom(options)
    await assert.rejects(vm.runInContext(packagedRendererDomExpression('receive-save', 0), dom.context))
    assert.equal(dom.saved(), 0)
  }
})

test('DAT表单不操作原禁用磁带类型，仍由原介质change触发', async () => {
  const dom = controlledDom(); await vm.runInContext(packagedRendererDomExpression('receive-save', 3), dom.context)
  assert.equal(dom.saved(), 1); assert.equal(dom.controls.get('介质')?.value, 'dat')
  assert.equal(dom.events.some(event => event.label === '磁带类型'), false)
})
