#!/usr/bin/env python3
"""Generate editable, self-contained DBot XML presets from stock/custom blocks."""
import copy
from pathlib import Path
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1] / 'src/lib/bot-store/bots'
NS = 'http://www.w3.org/1999/xhtml'
ET.register_namespace('', NS)
q = lambda n: '{%s}%s' % (NS, n)
base = ET.parse(ROOT / 'ai-even-switcher.xml').getroot()
seq = 0

def node(tag, **attrs): return ET.Element(q(tag), attrs)
def block(kind):
    global seq
    seq += 1
    return node('block', type=kind, id='price%04d' % seq)
def field(b, name, value, **attrs):
    e = ET.SubElement(b, q('field'), {'name': name, **attrs}); e.text = str(value)
    return b
def val(b, name, child):
    e = ET.SubElement(b, q('value'), {'name': name}); e.append(child); return b
def statement(b, name, child):
    e = ET.SubElement(b, q('statement'), {'name': name}); e.append(child); return b
def num(value): return field(block('math_number'), 'NUM', value)
def get(name): return field(block('variables_get'), 'VAR', name, id='v'+name.replace(' ', '_'))
def setvar(name, value): return val(field(block('variables_set'), 'VAR', name, id='v'+name.replace(' ', '_')), 'VALUE', value)
def chain(*blocks):
    for a,b in zip(blocks, blocks[1:]): ET.SubElement(a, q('next')).append(b)
    return blocks[0]
def compare(op, left, right): return val(val(field(block('logic_compare'), 'OP', op), 'A', left), 'B', right)
def arith(op, left, right): return val(val(field(block('math_arithmetic'), 'OP', op), 'A', left), 'B', right)
def ifblock(cond, yes, no=None):
    b=block('controls_if')
    if no is not None: ET.SubElement(b,q('mutation'), {'else':'1'})
    val(b,'IF0',cond); statement(b,'DO0',yes)
    if no is not None: statement(b,'ELSE',no)
    return b
def part(name): return val(field(block('x_price_decision_part'), 'PART', name), 'PLAN', get('decision'))
def risk(legs):
    b=block('x_price_risk')
    for name, child in [('STAKE', get('stake')), ('LEGS', num(legs)), ('BASELINE', get('baseline profit')), ('LOSS', get('loss limit')), ('TARGET', get('profit target')), ('PERCENT', get('balance percent'))]: val(b,name,child)
    return b

def produce(filename, kind):
    global seq
    seq=0
    hedged=kind=='hedge'; tick=kind=='tick'; legs=2 if hedged else 1
    var_defaults={'base stake':0.35, 'stake':0.35, 'loss limit':10, 'profit target':10, 'balance percent':5,
                  'duration':5 if tick else 4, 'threshold':0.30 if tick else 0.56,
                  'loss count':0, 'max steps':3, 'multiplier':2, 'max stake':2.8, 'baseline profit':0, 'decision':0}
    root=node('xml',collection='false',is_dbot='true')
    variables=ET.SubElement(root,q('variables'))
    for name in var_defaults:
        x=ET.SubElement(variables,q('variable'),{'type':'','id':'v'+name.replace(' ','_')});x.text=name
    trade=copy.deepcopy(base.find("./%s[@type='trade_definition']" % q('block')))
    for b in trade.iter(q('block')):
        t=b.get('type')
        for f in b.findall(q('field')):
            name=f.get('name')
            if t=='trade_definition_market':
                if name=='SUBMARKET_LIST': f.text='step_index' if hedged else 'random_index'
                if name=='SYMBOL_LIST': f.text='stpRNG' if hedged else 'R_100'
            if t=='trade_definition_tradetype':
                if name=='TRADETYPECAT_LIST': f.text='highlowticks' if tick else 'callput'
                if name=='TRADETYPE_LIST': f.text='highlowticks' if tick else 'callput'
            if t=='trade_definition_restartonerror' and name=='RESTARTONERROR': f.text='FALSE'
    init=trade.find("./%s[@name='INITIALIZATION']" % q('statement')); init.clear();init.set('name','INITIALIZATION')
    sets=[setvar(k, get('base stake') if k == 'stake' else num(v)) for k,v in var_defaults.items() if k not in ['baseline profit','decision']]
    sets += [setvar('baseline profit', block('x_session_profit'))]
    init.append(chain(*sets))
    sub=trade.find("./%s[@name='SUBMARKET']" % q('statement')); sub.clear();sub.set('name','SUBMARKET')
    opts=block('trade_definition_tradeoptions')
    ET.SubElement(opts,q('mutation'), {'has_first_barrier':'false','has_second_barrier':'false','has_prediction':'true' if tick else 'false'})
    field(opts,'DURATIONTYPE_LIST','t');field(opts,'CURRENCY_LIST','USD')
    val(opts,'DURATION',get('duration'));val(opts,'AMOUNT',get('stake'))
    if tick: val(opts,'PREDICTION',num(1)) # purchase block overrides with current decision
    field(opts,'AMOUNT_LIMITS',''); sub.append(opts);root.append(trade)
    before=block('before_purchase');before.set('x','0');before.set('y','760')
    decision=field(block('x_price_decision'),'MODE','tick' if tick else 'step-hedge' if hedged else 'rise')
    val(decision,'LIST',block('ticks'));val(decision,'HORIZON',get('duration'));val(decision,'THRESHOLD',get('threshold'))
    calc=setvar('decision',decision)
    if hedged:
        buy=field(field(block('hedge_purchase'),'PURCHASE_LIST','CALL'),'HEDGE_LIST','PUT')
    elif tick:
        buy=val(val(block('x_tick_decision_purchase'),'SIDE',part('side')),'TICK',part('tick'))
    else:
        rise=field(block('purchase'),'PURCHASE_LIST','CALL');fall=field(block('purchase'),'PURCHASE_LIST','PUT')
        buy=ifblock(compare('EQ',part('side'),num(1)),rise,fall)
    both=val(val(field(block('logic_operation'),'OP','AND'),'A',compare('EQ',part('ready'),num(1))),'B',risk(legs))
    statement(before,'BEFOREPURCHASE_STACK',chain(calc,ifblock(both,buy)));root.append(before)
    after=block('after_purchase');after.set('x','0');after.set('y','1150')
    again=ifblock(risk(legs),block('trade_again'))
    if not hedged:
        reset=chain(setvar('stake',get('base stake')),setvar('loss count',num(0)))
        increment=setvar('loss count',arith('ADD',get('loss count'),num(1)))
        grow=arith('MULTIPLY',get('stake'),get('multiplier'))
        capok=val(val(field(block('logic_operation'),'OP','AND'),'A',compare('LTE',get('loss count'),get('max steps'))),'B',compare('LTE',copy.deepcopy(grow),get('max stake')))
        # copy creates duplicate IDs: construct a fresh multiplication for the assignment.
        growstep=setvar('stake',arith('MULTIPLY',get('stake'),get('multiplier')))
        ladder=chain(increment,ifblock(capok,growstep,chain(setvar('stake',get('base stake')),setvar('loss count',num(0)))))
        result=field(block('contract_check_result'),'CHECK_RESULT','win')
        statement(after,'AFTERPURCHASE_STACK',chain(ifblock(result,reset,ladder),again))
    else: statement(after,'AFTERPURCHASE_STACK',again)
    root.append(after)
    ET.indent(root, space='  ')
    ET.ElementTree(root).write(ROOT / filename,encoding='utf-8',xml_declaration=True)

produce('high-low-tick-sniper.xml','tick')
produce('rise-fall-ensemble.xml','rise')
produce('step-rise-fall-hedge.xml','hedge')
