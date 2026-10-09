import assert from "node:assert/strict";
import test from "node:test";
import { faceMaskSpec, facePresentationTransform } from "../app/face-presentation.ts";
const geometry=(layout)=>({structure:Array(13).fill(0),surface:Array(300).fill(0),projection:Array(936).fill(0),layout});
test("face presentation follows source position independently of image identity",()=>{const c=geometry([.5,.5,.3,.4]);const a=facePresentationTransform(c,geometry([.72,.74,.3,.4]),1,true);const b=facePresentationTransform(c,geometry([.28,.26,.3,.4]),1,true);assert.ok(a.xPercent>0&&a.yPercent>0);assert.ok(b.xPercent<0&&b.yPercent<0);assert.equal(a.scale,b.scale);});
test("face presentation follows source face size",()=>{const c=geometry([.5,.5,.28,.36]);const s=facePresentationTransform(c,geometry([.5,.5,.2,.26]),1,true);const l=facePresentationTransform(c,geometry([.5,.5,.46,.58]),1,true);assert.ok(l.scale>s.scale);});
test("tracking can be disabled without changing selection",()=>{assert.deepEqual(facePresentationTransform(geometry([.3,.4,.28,.36]),geometry([.8,.7,.5,.6]),1,false),{xPercent:0,yPercent:0,scale:1});});
test("face-only mask keeps old bounded feather geometry",()=>{assert.deepEqual(faceMaskSpec([.5,.5,.6,.75]),{centerX:.5,centerY:.5,radiusX:.312,radiusY:.405});assert.deepEqual(faceMaskSpec([0,1,2,2]),{centerX:.15,centerY:.85,radiusX:.43,radiusY:.49});});
