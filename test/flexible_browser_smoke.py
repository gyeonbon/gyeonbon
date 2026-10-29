"""Optional Chromium UI checks for flexible2–30 participant classrooms.
Run against a built server: BASE_URL=http://127.0.0.1:3010 python3 test/flexible_browser_smoke.py
"""
import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright
from browser_smoke import state, act

BASE=os.environ.get('BASE_URL','http://127.0.0.1:3000').rstrip('/')
OUT=Path('test-results')

async def main():
    errors=[]
    OUT.mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser=await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'),headless=True,args=['--no-sandbox'])
        async def page(mobile=False):
            c=await browser.new_context(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':1000},has_touch=mobile,is_mobile=mobile)
            pg=await c.new_page();pg.on('pageerror',lambda e:errors.append(str(e)));return pg
        async def create(title,groups='1'):
            pg=await page();await pg.goto(BASE)
            await pg.get_by_role('button',name='🏫 선생님, 수업 열기').click()
            await pg.locator('[name=title]').fill(title)
            await pg.locator('[name=groupCount]').select_option(groups)
            await pg.get_by_role('button',name='수업 만들고 초대하기').click()
            await pg.wait_for_selector('.invite-code')
            return pg,(await pg.locator('.invite-code').inner_text())
        async def join(code,name,mobile=False):
            pg=await page(mobile);await pg.goto(f'{BASE}/?join={code}')
            await pg.locator('[name=name]').fill(name)
            await pg.get_by_role('button',name='도전 입장하기').click()
            await pg.wait_for_selector('.student-welcome');return pg
        teacher,code=await create('2인 모둠 기능 확인','2')
        a=await join(code,'설명 친구',True);b=await join(code,'그림 친구',True)
        await a.locator('.group-choice').filter(has_text='1모둠').click()
        await b.locator('.group-choice').filter(has_text='2모둠').click()
        b_id=(await state(b))['me']['id']
        await teacher.get_by_role('button',name='2모둠 삭제',exact=True).click()
        await teacher.get_by_role('button',name='모둠 삭제하기',exact=True).click()
        await b.wait_for_function("() => !document.querySelector('.group-choice.active')")
        assert (await state(b))['me']['groupId'] is None
        assert len((await state(teacher))['students'])==2
        for _ in range(3):await teacher.get_by_role('button',name='＋ 모둠 추가',exact=True).click()
        await teacher.get_by_role('heading',name='5모둠',exact=False).wait_for()
        await b.locator('.group-choice').filter(has_text='5모둠').wait_for()
        assert await b.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await teacher.get_by_role('button',name='인원에 맞춰 자동 편성').click()
        await teacher.wait_for_function("() => document.querySelectorAll('.group-card').length===1")
        assert (await state(b))['me']['id']==b_id
        await teacher.get_by_label('질문 기회').select_option('0')
        await teacher.locator('.explainer-select select').select_option((await state(a))['me']['id'])
        await teacher.get_by_role('button',name='1개 모둠 동시에 시작').click()
        await a.wait_for_selector('.word-button')
        word=await a.locator('.word-button strong').first.inner_text()
        await a.locator('.word-button').first.click()
        await b.wait_for_selector('.canvas-wrap canvas')
        own=await state(b);assert 'word' not in own['groups'][0] and 'choices' not in own['groups'][0]
        box=await b.locator('.canvas-wrap canvas').bounding_box()
        cdp=await b.context.new_cdp_session(b)
        await cdp.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':box['x']+40,'y':box['y']+40}]})
        for n in range(1,10):await cdp.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':box['x']+40+n*8,'y':box['y']+40+n*4}]})
        await cdp.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        await b.wait_for_function("() => document.querySelector('.canvas-status').textContent.includes('서버에 저장')")
        await b.reload();await b.wait_for_selector('.canvas-wrap canvas')
        assert len((await state(b))['me']['drawing'])==1
        await a.get_by_role('button',name='설명했어요! 질문 받아볼까요?').click()
        await b.wait_for_selector('.guess-form')
        await b.locator('.guess-form input').fill(' '.join(word))
        await b.locator('.guess-form button').click()
        await b.wait_for_selector('.art-card')
        assert (await state(teacher))['status']=='review'
        assert (await state(b))['groups'][0]['results']['drawings'][0]['correct']
        assert await b.locator('.art-card').count()==1
        await b.screenshot(path=str(OUT/'two-student-result.png'),full_page=True)
        assert (await act(teacher,'end'))['status']==200

        t30,code30=await create('30인 모둠 기능 확인')
        students=[]
        for start in range(0,30,5):students.extend(await asyncio.gather(*(join(code30,f'모둠친구{i+1:02d}',i<5) for i in range(start,min(start+5,30)))))
        await t30.wait_for_function("() => document.querySelector('.teacher-controls').textContent.includes('30 / 30명')")
        await t30.get_by_role('button',name='인원에 맞춰 자동 편성').click()
        await t30.wait_for_function("() => document.querySelectorAll('.group-card').length===6")
        current=await state(t30)
        assert all(sum(s['groupId']==g['id'] for s in current['students'])==5 for g in current['groups'])
        assert await t30.locator('.roster-item select').first.locator('option').count()==7
        await students[0].locator('.group-choice').filter(has_text='6모둠').wait_for()
        assert await students[0].evaluate('document.documentElement.scrollWidth<=innerWidth')
        await t30.screenshot(path=str(OUT/'thirty-student-dashboard.png'),full_page=True)
        await students[0].screenshot(path=str(OUT/'six-group-mobile.png'),full_page=True)
        extra=await page();await extra.goto(f'{BASE}/?join={code30}')
        await extra.locator('[name=name]').fill('31번째 참가자')
        await extra.get_by_role('button',name='도전 입장하기').click()
        await extra.wait_for_function("() => document.querySelector('.join-card .error').textContent.includes('최대 30명')")
        await t30.get_by_role('button',name='6개 모둠 동시에 시작').click()
        by_id={}
        for pg in students:by_id[(await state(pg))['me']['id']]=pg
        for g in (await state(t30))['groups']:
            exp=by_id[g['explainerId']]
            await exp.wait_for_selector('.word-button');await exp.locator('.word-button').first.click()
        strokes=[{'tool':'pen','color':'#699bdb','size':6,'points':[[.1,.2],[.6,.7]]}]
        drawers=[]
        for pg in students:
            if not (await state(pg))['me']['isExplainer']:drawers.append(pg)
        await asyncio.gather(*(act(pg,'drawing',strokes=strokes) for pg in drawers))
        await t30.get_by_role('button',name='모든 결과 바로 공개').click()
        await t30.get_by_role('button',name='그림 갤러리').click()
        await t30.wait_for_selector('.art-card')
        assert await t30.locator('.gallery-group').count()==6
        assert await t30.locator('.art-card').count()==24
        assert len((await state(t30))['groups'])==6
        assert not errors,errors
        assert (await act(t30,'end'))['status']==200
        print(json.dumps({'passed':['2student fullround','occupied group deletion preserves students','monotonic group IDs after delete','responsive group5+metadata','automatic2student1group','mobile touch+autosave+reload','30student UIjoin','6groups of5','31st student rejected','all6groups play','24drawings gallery'],'page_errors':errors},ensure_ascii=False,indent=2))
        await browser.close()

if __name__=='__main__':asyncio.run(main())
