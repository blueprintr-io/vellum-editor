import assert from 'node:assert/strict';
import test from 'node:test';
import type { Connector, Shape } from '../src/store/types';
import { fromShapeLocal } from '../src/editor/canvas/projection';
import {
  autoAnchor,
  connectorPolyline,
  nearest8Anchor,
  resolveConnectorPath,
  resolveEndpointPoint,
  shapeAnchorPoint,
  shapeAnchorWorldPoint,
} from '../src/editor/canvas/routing';
import { nearestSmartAnchor, smartAnchorPoints } from '../src/editor/canvas/smart-anchors';

const triangle: Shape = {
  id: 'triangle', kind: 'polygon', layer: 'blueprint', x: 100, y: 150, w: 200, h: 100,
  polygonVertices: [{x:0,y:0},{x:1,y:0},{x:0,y:1}],
};
const close = (actual: number, expected: number) =>
  assert.ok(Math.abs(actual-expected) < 1e-8, `${actual} ≈ ${expected}`);

test('fixed anchors mirror with an asymmetric outline, without changing the box', () => {
  assert.deepEqual(shapeAnchorPoint(triangle,'left'),[100,200]);
  assert.deepEqual(shapeAnchorPoint({...triangle,flipH:true},'left'),[300,200]);
  assert.deepEqual(shapeAnchorPoint(triangle,[0,0]),[100,150]);
  assert.deepEqual(shapeAnchorPoint({...triangle,flipH:true},[0,0]),[300,150]);
  assert.deepEqual(shapeAnchorPoint({...triangle,flipV:true},[0,0]),[100,250]);
  assert.deepEqual(shapeAnchorPoint({...triangle,flipH:true,flipV:true},[0,0]),[300,250]);
});

test('all smart dots and nearest-port snapping follow horizontal and vertical mirrors before rotation', () => {
  const samples: Shape[] = [
    triangle,
    {...triangle,kind:'rect',polygonVertices:undefined},
    {...triangle,kind:'ellipse',polygonVertices:undefined},
    {...triangle,polygonVertices:undefined,polygonPreset:'parallelogram'},
    {...triangle,polygonVertices:undefined,polygonPreset:'callout',callout:{side:'left',tip:1.2}},
    {...triangle,kind:'service',notation:{type:'flow-manual-input'}},
    {...triangle,kind:'service',notation:{type:'uml-lifeline'}},
  ];
  for (const original of samples) {
    const points = smartAnchorPoints(original,true,16);
    for (const flipH of [false,true]) for (const flipV of [false,true]) {
      const shape={...original,flipH,flipV,rotation:37};
      const mirrored=smartAnchorPoints(shape,true,16);
      points.forEach((point,i)=>{
        const x=flipH?2*shape.x+shape.w-point.x:point.x;
        const y=flipV?2*shape.y+shape.h-point.y:point.y;
        close(mirrored[i].x,x); close(mirrored[i].y,y);
        assert.equal(mirrored[i].fx,point.fx); assert.equal(mirrored[i].fy,point.fy);
        const world=fromShapeLocal({x,y},shape);
        const hit=nearestSmartAnchor(shape,world,true,16,0.01)!;
        assert.ok(hit); close(hit.x,world.x); close(hit.y,world.y);
        const resolved=resolveEndpointPoint({shape:shape.id,anchor:hit.anchor},{x:800,y:600},[shape])!;
        close(resolved.x,world.x); close(resolved.y,world.y);
      });
    }
  }
  const flipped={...triangle,flipH:true,rotation:30};
  const corner=fromShapeLocal({x:300,y:150},flipped);
  assert.deepEqual(nearest8Anchor(flipped,corner),[0,0]);
});

test('auto anchors aim toward the target through mirrors and rotations', () => {
  const rectangle: Shape={...triangle,kind:'rect',polygonVertices:undefined};
  for (const flipH of [false,true]) for (const flipV of [false,true]) for (const rotation of [0,30,90]) {
    const shape={...rectangle,flipH,flipV,rotation};
    for(const [target,expected] of [
      [{x:700,y:200},{x:300,y:200}],
      [{x:200,y:-100},{x:200,y:150}],
    ]) {
      const world=fromShapeLocal(target,shape),expectedWorld=fromShapeLocal(expected,shape);
      const anchor=autoAnchor(shape,world);
      const point=shapeAnchorWorldPoint(shape,anchor);
      close(point[0],expectedWorld.x);close(point[1],expectedWorld.y);
    }
  }
  // On a flipped right triangle the vertical edge is on the right. Casting
  // against the old outline instead would stop at the middle of the box.
  const flipped={...triangle,flipH:true};
  assert.deepEqual(shapeAnchorWorldPoint(flipped,autoAnchor(flipped,{x:700,y:200})),[300,200]);
});

test('elbows and setbacks leave the mirrored side while stored anchor IDs remain unchanged', () => {
  const conn: Connector={id:'wire',from:{shape:'triangle',anchor:'left'},to:{x:700,y:400},routing:'orthogonal'};
  const original=structuredClone(conn);
  for(const rotation of [0,90]) {
    const shape={...triangle,flipH:true,rotation};
    const path=resolveConnectorPath(conn,[shape])!;
    assert.equal(path.fromAnchor,'right');
    const points=connectorPolyline(conn,path.fx,path.fy,path.tx,path.ty,path.fromAnchor,path.toAnchor,path.fromRot,path.toRot,path.fromRect,path.toRect);
    if(rotation===0) {
      assert.ok(points[1].x>points[0].x);close(points[1].y,points[0].y);
    } else {
      assert.ok(points[1].y>points[0].y);close(points[1].x,points[0].x);
    }
    const inset=resolveConnectorPath(conn,[shape],10,0)!;
    close(inset.fx,path.fx+(rotation===0?10:0));
    close(inset.fy,path.fy+(rotation===90?10:0));
    assert.deepEqual(conn,original);
  }
});

test('kinds whose bodies cannot mirror ignore stray mirror flags for anchors too', () => {
  for(const kind of ['rack','table','group','freehand'] as const) {
    const shape={...triangle,kind,polygonVertices:undefined};
    assert.deepEqual(shapeAnchorWorldPoint({...shape,flipH:true,flipV:true},'left'),shapeAnchorWorldPoint(shape,'left'));
  }
});
