"""Optional real-browser classroom smoke test. Run against an already built/running server.
Requires Python playwright and Chromium (CHROMIUM_PATH can override its path).
Artifacts are written to ignored test-results/. Does not print participant tokens.
"""
import asyncio
import json
import os
from pathlib import Path
from playwright.async_api import async_playwright

BASE = os.environ.get('BASE_URL', 'http://127.0.0.1:3000').rstrip('/')
OUT = Path('test-results')
ERRORS = []

async def state(page):
    return await page.evaluate('''async () => {
      const q=new URLSearchParams(location.search), code=q.get('session');
      const role=q.get('view')==='teacher'?'teacher':'student';
      const c=JSON.parse(localStorage.getItem(`btc:${code}:${role}`));
      return (await fetch(`/api/sessions/${code}/state`,{headers:{Authorization:`Bearer ${c.token}`}})).json();
    }''')

async def act(page, kind, **data):
    result = await page.evaluate('''async ({type,...args}) => {
      const q=new URLSearchParams(location.search),code=q.get('session');
      const role=q.get('view')==='teacher'?'teacher':'student';
      const c=JSON.parse(localStorage.getItem(`btc:${code}:${role}`));
      const r=await fetch(`/api/sessions/${code}/actions`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${c.token}`},body:JSON.stringify({type,...args})});
      return {status:r.status,data:await r.json()};
    }''', {'type':kind,**data})
    return result

async def main():
    OUT.mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        second_browser = await p.chromium.launch(executable_path=os.environ.get('CHROMIUM_PATH','/usr/bin/chromium'), headless=True, args=['--no-sandbox'])
        contexts=[]
        async def new_page(mobile=False, second=False):
            b=second_browser if second else browser
            ctx=await b.new_context(viewport={'width':390,'height':844} if mobile else {'width':1440,'height':1000},has_touch=mobile,is_mobile=mobile,device_scale_factor=1)
            contexts.append(ctx)
            page=await ctx.new_page();page.on('pageerror',lambda error:ERRORS.append(str(error)))
            return page
        teacher=await new_page()
        await teacher.goto(BASE)
        await teacher.screenshot(path=str(OUT/'landing-desktop.png'),full_page=True)
        await teacher.get_by_role('button',name='🏫 선생님, 수업 열기').click()
        await teacher.locator('[name=title]').fill('2학년 교육학과 진로체험')
        await teacher.get_by_role('button',name='수업 만들고 초대하기').click()
        await teacher.wait_for_selector('.invite-code')
        code=await teacher.locator('.invite-code').inner_text()
        assert len(code)==6 and code.isdigit()
        await teacher.wait_for_selector('.qr-code[src^="data:image"]')
        await teacher.locator('.qr-code').screenshot(path=str(OUT/'entry-qr.png'))
        assert await teacher.locator('.invite-url').input_value()==f'{BASE}/?join={code}'
        pages=[]
        async def join(i):
            page=await new_page(mobile=(i<18),second=(i%2==1))
            await page.goto(f'{BASE}/?join={code}')
            await page.locator('[name=name]').fill(f'그림친구{i+1:02d}')
            await page.get_by_role('button',name='도전 입장하기').click()
            await page.wait_for_selector('.student-welcome')
            return page
        # Independent storage in nineteen browser contexts, across two browser processes.
        for start in range(0,19,5):
            pages.extend(await asyncio.gather(*(join(i) for i in range(start,min(start+5,19)))))
        await teacher.wait_for_function("() => document.querySelector('.teacher-controls').textContent.includes('19 / 30명')")
        await teacher.get_by_role('button',name='인원에 맞춰 자동 편성').click()
        s=await state(teacher)
        counts=[sum(x['groupId']==str(g) for x in s['students']) for g in range(1,5)]
        assert sorted(counts)==[4,5,5,5]
        by_id={(await state(page))['me']['id']:page for page in pages}
        for g in s['groups']:
            first=next(x for x in s['students'] if x['groupId']==g['id'])
            assert (await act(teacher,'assignExplainer',groupId=g['id'],studentId=first['id']))['status']==200
        await teacher.screenshot(path=str(OUT/'teacher-dashboard.png'),full_page=True)
        await teacher.get_by_role('button',name='4개 모둠 동시에 시작').click()
        s=await state(teacher)
        assert all(g['phase']=='choosing' for g in s['groups'])
        assert max(g['deadline'] for g in s['groups'])-min(g['deadline'] for g in s['groups'])<100
        words={}
        for g in s['groups']:
            exp=by_id[g['explainerId']]
            await exp.wait_for_selector('.word-button')
            words[g['id']]=await exp.locator('.word-button strong').first.inner_text()
            await exp.locator('.word-button').first.click()
        drawer_states=[(await state(page),page) for page in pages]
        drawers=[(s,page) for s,page in drawer_states if not s['me']['isExplainer']]
        for ss,page in drawers:
            own=next(g for g in ss['groups'] if g['id']==ss['me']['groupId'])
            assert 'word' not in own and 'choices' not in own
            assert all(not g.get('results') and 'word' not in g for g in ss['groups'] if g['id']!=ss['me']['groupId'])
        assert 'word' not in (await state(teacher))['groups'][0]
        drawing_page=drawers[0][1]
        await drawing_page.wait_for_selector('.canvas-wrap canvas')
        box=await drawing_page.locator('.canvas-wrap canvas').bounding_box()
        x,y=box['x']+35,box['y']+35
        # Touch events exercise the browser's touch->pointer path on the mobile participant.
        if await drawing_page.evaluate('navigator.maxTouchPoints'):
            session=await drawing_page.context.new_cdp_session(drawing_page)
            await session.send('Input.dispatchTouchEvent',{'type':'touchStart','touchPoints':[{'x':x,'y':y}]})
            for n in range(1,10):await session.send('Input.dispatchTouchEvent',{'type':'touchMove','touchPoints':[{'x':x+n*8,'y':y+n*5}]})
            await session.send('Input.dispatchTouchEvent',{'type':'touchEnd','touchPoints':[]})
        else:
            await drawing_page.mouse.move(x,y);await drawing_page.mouse.down();await drawing_page.mouse.move(x+80,y+60,steps=12);await drawing_page.mouse.up()
        await drawing_page.wait_for_function("() => document.querySelector('.canvas-status').textContent.includes('서버에 저장')")
        assert len((await state(drawing_page))['me']['drawing'])==1
        # Other drawers have independent private drawings, submitted concurrently.
        line=[{'tool':'pen','color':'#ed797d','size':6,'points':[[.2,.2],[.7,.6]]}]
        await asyncio.gather(*(act(page,'drawing',strokes=line) for _,page in drawers[1:]))
        own_id=(await state(drawing_page))['me']['id']
        await drawing_page.reload();await drawing_page.wait_for_selector('.canvas-wrap canvas')
        assert (await state(drawing_page))['me']['id']==own_id
        assert len((await state(drawing_page))['me']['drawing'])==1
        # Pause/reload/resume uses exactly the server's remaining duration.
        await teacher.get_by_role('button',name='전체 일시정지').click()
        paused=await state(drawing_page)
        assert paused['paused'] and all(g['deadline'] is None for g in paused['groups'])
        await teacher.get_by_role('button',name='타이머 재개').click()
        assert not (await state(drawing_page))['paused']
        for g in (await state(teacher))['groups']:
            exp=by_id[g['explainerId']]
            await exp.locator('#chat-input').fill('큰 동그라미 아래에 작은 네모가 있어요.')
            await exp.get_by_role('button',name='메시지 보내기').click()
            await exp.get_by_role('button',name='설명했어요! 질문 받아볼까요?').click()
        current=await state(teacher)
        first_group=current['groups'][0]
        questioner=by_id[first_group['questionerId']]
        await questioner.locator('#chat-input').fill('작은 부분은 어느 쪽에 있나요?')
        await questioner.get_by_role('button',name='메시지 보내기').click()
        exp=by_id[first_group['explainerId']]
        await exp.locator('#chat-input').fill('아래쪽 가운데에 있어요.')
        await exp.get_by_role('button',name='메시지 보내기').click()
        await questioner.wait_for_function("() => document.querySelector('.phase-description').textContent.includes('10초')")
        assert (await state(questioner))['groups'][0]['questionStage']=='grace'
        await questioner.screenshot(path=str(OUT/'student-game.png'),full_page=True)
        assert await questioner.evaluate('document.documentElement.scrollWidth<=innerWidth')
        # Teacher facilitation can advance remaining questions without waiting for test timeouts.
        for g in (await state(teacher))['groups']:
            for _ in range(10):
                gs=next(x for x in (await state(teacher))['groups'] if x['id']==g['id'])
                if gs['phase']=='guessing':break
                assert (await act(teacher,'advance',groupId=g['id']))['status']==200
        for ss,page in drawers:
            gid=ss['me']['groupId']
            await page.wait_for_selector('.guess-form')
            await page.locator('.guess-form input').fill(words[gid] if page==drawing_page else '다르게 생각했어요')
            await page.locator('.guess-form button').click()
        await teacher.get_by_role('button',name='그림 갤러리').click()
        await teacher.wait_for_selector('.art-card')
        end=await state(teacher)
        assert end['status']=='review'
        assert sum(len(g['results']['drawings']) for g in end['groups'])==15
        assert all(len(g['results']['drawings'])>=3 for g in end['groups'])
        own=await state(drawing_page)
        my_group=next(g for g in own['groups'] if g['id']==own['me']['groupId'])
        assert next(x for x in my_group['results']['drawings'] if x['studentId']==own_id)['correct']
        assert all('results' not in g for g in own['groups'] if g['id']!=own['me']['groupId'])
        await teacher.screenshot(path=str(OUT/'teacher-gallery.png'),full_page=True)
        await teacher.get_by_role('button',name='발표 화면',exact=False).click()
        assert await teacher.locator('.app.presentation').count()==1
        await teacher.screenshot(path=str(OUT/'presentation.png'),full_page=True)
        # Gallery export and student reflection are exercised from the actual UI.
        export=teacher.locator('button').filter(has_text='이미지').first
        async with teacher.expect_download() as download:
            await export.click()
        await (await download.value).save_as(str(OUT/'class-gallery.png'))
        await drawing_page.wait_for_selector('.reflection-form textarea')
        areas=drawing_page.locator('.reflection-form textarea')
        for i in range(await areas.count()):await areas.nth(i).fill(['모양을 다르게 떠올렸어요.','크다는 설명이 어려웠어요.','위치와 개수를 구체적으로 말할래요.','질문으로 이해했는지 확인하기'][i])
        await drawing_page.locator('.reflection-form button[type=submit]').click()
        await drawing_page.wait_for_function("() => document.querySelector('.reflection-form').textContent.includes('소감 저장됨')")
        assert (await state(drawing_page))['me']['reflection']['answers'][0]=='모양을 다르게 떠올렸어요.'
        await drawing_page.set_viewport_size({'width':390,'height':844})
        assert await drawing_page.evaluate('document.documentElement.scrollWidth<=innerWidth')
        await drawing_page.screenshot(path=str(OUT/'mobile-gallery.png'),full_page=True)
        # All results stay until the teacher chooses next attempt, even beyond15seconds.
        await asyncio.sleep(15)
        assert (await state(teacher))['status']=='review'
        assert (await act(teacher,'nextAttempt'))['status']==200
        assert (await state(drawing_page))['attempt']==2
        assert len((await state(teacher))['history'][0]['groups'])==4
        assert not ERRORS,ERRORS
        print(json.dumps({'students':19,'browser_processes':2,'independent_contexts':20,'group_sizes':counts,'gallery_drawings':15,'checks':['numeric-code+QR','concurrent-join','teacher-authorization','secret-word-privacy','independent-drawing','touch/mouse-canvas','autosave+reload','server-timer-pause-resume','question-answer-grace','single-answer-reveal','allgroup-gallery+PNG','presentation','reflection','held-reveal+secondattempt'],'page_errors':ERRORS},ensure_ascii=False,indent=2))
        await browser.close();await second_browser.close()

if __name__ == '__main__':
    asyncio.run(main())
