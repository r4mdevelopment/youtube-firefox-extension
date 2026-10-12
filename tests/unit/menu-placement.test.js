import { expect,it } from 'vitest';
import { placeQualityMenu } from '../../src/content/menu-placement.js';
it('anchors below the button and follows its changed viewport position',()=>{
 expect(placeQualityMenu({left:200,top:100,bottom:136},{width:320,height:200},{width:1000,height:800})).toMatchObject({left:200,top:144});
 expect(placeQualityMenu({left:200,top:50,bottom:86},{width:320,height:200},{width:1000,height:800})).toMatchObject({left:200,top:94});
});
it('uses measured menu height to open above a low button and stays within viewport',()=>{
 const p=placeQualityMenu({left:950,top:700,bottom:736},{width:320,height:300},{width:1000,height:800});expect(p.left).toBe(668);expect(p.top).toBe(392);expect(p.maxHeight).toBeLessThanOrEqual(680);
});
