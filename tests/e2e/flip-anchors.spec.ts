import { expect, test, type Page } from './fixtures';

async function seed(page: Page, kind: 'polygon' | 'notation' | 'icon', rotation = 0) {
  await page.setViewportSize({width:1280,height:950});
  await page.goto('/');
  await page.locator('[data-chrome="toolbar-row"]').waitFor();
  await page.evaluate(async ({kind,rotation})=>{
    const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    useEditor.setState({hasCompletedOnboarding:true,pan:{x:70,y:70},zoom:0.9,activeTool:'1',readOnly:false,layerMode:'both',smartAnchorsGlobal:true,smartAnchorCountGlobal:8,libraryPanelOpen:false,inspectorOpen:false});
    const common={id:'subject',x:240,y:200,w:240,h:160,rotation,layer:'blueprint',label:'',strokeWidth:2};
    const fields=kind==='polygon'
      ? {kind:'polygon',polygonVertices:[{x:0,y:0},{x:1,y:0},{x:0,y:1}]}
      : kind==='notation'
        ? {kind:'service',notation:{type:'flow-manual-input'}}
        : {kind:'icon',w:200,h:200,iconSvg:'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="M10 10H90L10 90Z" fill="currentColor"/></svg>',iconAttribution:{source:'iconify',iconId:'test:asymmetric',holder:'Test fixture',license:'CC0-1.0',sourceUrl:'https://example.test/icon'}};
    const st=useEditor.getState();
    st.loadDiagram({version:'1.0',meta:{title:'Mirrored anchors'},shapes:[{...common,...fields}],connectors:[{id:'wire',from:{shape:'subject',anchor:[0,0.5]},to:{x:780,y:500},routing:'straight',fromMarker:'none',toMarker:'none',layer:'blueprint'}],annotations:[]},null);
    st.setSelected('subject');
    useEditor.setState({inspectorOpen:false});
  },{kind,rotation});
  if(kind==='icon') await expect.poll(()=>page.evaluate(async()=>!!(window.__VELLUM_TEST__!.modules['/src/editor/canvas/silhouette.ts']).getIconSilhouette('test:asymmetric'))).toBe(true);
  await expect(page.locator('[data-shape-anchors="subject"] circle')).toHaveCount(16);
}

async function snapshot(page: Page) {
  return page.evaluate(async()=>{
    const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
    const st=useEditor.getState(), shape=st.diagram.shapes.find(s=>s.id==='subject')!;
    const screen=(el:SVGGraphicsElement,x:number,y:number)=>{
      const p=new DOMPoint(x,y).matrixTransform(el.getScreenCTM()!);
      return {x:p.x,y:p.y};
    };
    const dots=Array.from(document.querySelectorAll<SVGCircleElement>('[data-shape-anchors="subject"] circle')).map(el=>({fx:Number(el.dataset.anchorFx),fy:Number(el.dataset.anchorFy),...screen(el,el.cx.baseVal.value,el.cy.baseVal.value)}));
    const frame=document.querySelector('[data-shape-id="subject"]')!.parentNode as SVGGraphicsElement;
    const wire=document.querySelector<SVGPathElement>('[data-connector-id="wire"] > path')!;
    const start=wire.getPointAtLength(0);
    return {diagram:st.diagram,past:st.past.length,dots,center:screen(frame,shape.x+shape.w/2,shape.y+shape.h/2),wire:screen(wire,start.x,start.y)};
  });
}

const samePoint=(a:{x:number;y:number},b:{x:number;y:number})=>{
  expect(a.x).toBeCloseTo(b.x,2);expect(a.y).toBeCloseTo(b.y,2);
};

for(const [kind,rotation] of [['polygon',0],['polygon',35],['notation',20],['icon',25]] as const)
  test(`${kind} at ${rotation} degrees mirrors ports and attached lines through undo and reload`,async({page})=>{
    await seed(page,kind,rotation);
    const before=await snapshot(page);
    await page.keyboard.press('Shift+h');
    const horizontal=await snapshot(page);
    expect(horizontal.past).toBe(before.past+1);
    horizontal.dots.forEach((dot,i)=>samePoint(dot,{x:2*before.center.x-before.dots[i].x,y:before.dots[i].y}));
    samePoint(horizontal.wire,horizontal.dots.find(p=>p.fx===0&&p.fy===0.5)!);
    expect(horizontal.diagram.connectors).toEqual(before.diagram.connectors);
    if(kind==='polygon'&&rotation===35)await page.screenshot({path:test.info().outputPath('vellum-mirrored-anchors.png')});
    await page.keyboard.press('Shift+v');
    const both=await snapshot(page);
    both.dots.forEach((dot,i)=>samePoint(dot,{x:horizontal.dots[i].x,y:2*horizontal.center.y-horizontal.dots[i].y}));
    samePoint(both.wire,both.dots.find(p=>p.fx===0&&p.fy===0.5)!);
    await page.evaluate(async()=>(window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().undo());
    const undone=await snapshot(page);expect(undone.diagram).toEqual(horizontal.diagram);
    undone.dots.forEach((dot,i)=>samePoint(dot,horizontal.dots[i]));
    await page.evaluate(async()=>(window.__VELLUM_TEST__!.modules['/src/store/editor.ts']).useEditor.getState().redo());
    await page.evaluate(async()=>{
      const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];
      const {diagramToYaml,yamlToDiagram}=window.__VELLUM_TEST__!.modules['/src/store/persist.ts'];
      const st=useEditor.getState();st.loadDiagram(yamlToDiagram(diagramToYaml(st.diagram)),null);st.setSelected('subject');
    });
    const loaded=await snapshot(page);
    loaded.dots.forEach((dot,i)=>samePoint(dot,both.dots[i]));samePoint(loaded.wire,both.wire);
  });

test('drawing onto a flipped port saves its original anchor and stays attached when flipped back',async({page})=>{
  await seed(page,'polygon',25);
  await page.keyboard.press('Shift+h');
  const flipped=await snapshot(page),port=flipped.dots.find(p=>p.fx===0&&p.fy===0.5)!;
  await page.evaluate(async()=>{
    // A plain line has no arrowhead setback, so its drawn end meets the dot exactly.
    const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];useEditor.getState().setSelected(null);useEditor.setState({activeTool:'6',toolLock:false});
  });
  await page.mouse.move(830,740);await page.mouse.down();
  await page.mouse.move(port.x,port.y,{steps:12});await page.mouse.up();
  const connector=await page.evaluate(async()=>{
    const {useEditor}=window.__VELLUM_TEST__!.modules['/src/store/editor.ts'];const st=useEditor.getState();
    const c=st.diagram.connectors.find(c=>c.id!=='wire');st.setSelected('subject');return c;
  });
  expect(connector!.to).toEqual({shape:'subject',anchor:[0,0.5]});
  const endpoint=()=>page.evaluate((id)=>{
    const path=document.querySelector<SVGPathElement>(`[data-connector-id="${id}"] > path`)!;
    const p=path.getPointAtLength(path.getTotalLength());
    const screen=new DOMPoint(p.x,p.y).matrixTransform(path.getScreenCTM()!);
    return {x:screen.x,y:screen.y};
  },connector!.id);
  samePoint(await endpoint(),port);
  await page.keyboard.press('Shift+h');
  const restored=await snapshot(page);
  samePoint(await endpoint(),restored.dots.find(p=>p.fx===0&&p.fy===0.5)!);
});
