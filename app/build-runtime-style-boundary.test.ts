import { expect, test } from "bun:test";
import { assertReviewedRuntimeStyleBoundary } from "./build-runtime-style-boundary.ts";

// Exact parsed acquireResource functions from the reviewed production
// allocations. They are renderer capability, not requests to emit a style.
const firstReviewedFunction = String.raw`function Tk(n,r,a){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+Ln(a.href)+'"]');if(l)return r.instance=l,jt(l),l;var d=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),jt(l),$t(l,"style",d),nu(l,a.precedence,n),r.instance=l;case"stylesheet":d=Ys(a.href);var p=n.querySelector(lo(d));if(p)return r.state.loading|=4,r.instance=p,jt(p),p;l=Ek(a),(d=Qn.get(d))&&md(l,d),p=(n.ownerDocument||n).createElement("link"),jt(p);var k=p;return k._p=new Promise(function(w,j){k.onload=w,k.onerror=j}),$t(p,"link",l),r.state.loading|=4,nu(p,a.precedence,n),r.instance=p;case"script":return p=Fs(a.src),(d=n.querySelector(uo(p)))?(r.instance=d,jt(d),d):(l=a,(d=Qn.get(p))&&(l=g({},a),gd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),jt(d),$t(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,nu(l,a.precedence,n));return r.instance}`;
const secondReviewedFunction = String.raw`function Rb(n,r,a){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+Pn(a.href)+'"]');if(l)return r.instance=l,Mt(l),l;var d=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),Mt(l),Ut(l,"style",d),ru(l,a.precedence,n),r.instance=l;case"stylesheet":d=Js(a.href);var m=n.querySelector(ho(d));if(m)return r.state.loading|=4,r.instance=m,Mt(m),m;l=Mb(a),(d=Gn.get(d))&&kd(l,d),m=(n.ownerDocument||n).createElement("link"),Mt(m);var k=m;return k._p=new Promise(function(S,O){k.onload=S,k.onerror=O}),Ut(m,"link",l),r.state.loading|=4,ru(m,a.precedence,n),r.instance=m;case"script":return m=ea(a.src),(d=n.querySelector(po(m)))?(r.instance=d,Mt(d),d):(l=a,(d=Gn.get(m))&&(l=g({},a),xd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),Mt(d),Ut(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,ru(l,a.precedence,n));return r.instance}`;
const themeReviewedFunction = String.raw`function Wb(n,i,a){if(i.count++,i.instance===null)switch(i.type){case"style":var u=n.querySelector('style[data-href~="'+$n(a.href)+'"]');if(u)return i.instance=u,zt(u),u;var d=y({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return u=(n.ownerDocument||n).createElement("style"),zt(u),Bt(u,"style",d),hu(u,a.precedence,n),i.instance=u;case"stylesheet":d=ia(a.href);var m=n.querySelector(vo(d));if(m)return i.state.loading|=4,i.instance=m,zt(m),m;u=Yb(a),(d=Gn.get(d))&&zd(u,d),m=(n.ownerDocument||n).createElement("link"),zt(m);var k=m;return k._p=new Promise(function(S,R){k.onload=S,k.onerror=R}),Bt(m,"link",u),i.state.loading|=4,hu(m,a.precedence,n),i.instance=m;case"script":return m=sa(a.src),(d=n.querySelector(wo(m)))?(i.instance=d,zt(d),d):(u=a,(d=Gn.get(m))&&(u=y({},a),Rd(u,d)),n=n.ownerDocument||n,d=n.createElement("script"),zt(d),Bt(d,"link",u),n.head.appendChild(d),i.instance=d);case"void":return null;default:throw Error(s(443,i.type))}else i.type==="stylesheet"&&(i.state.loading&4)===0&&(u=i.instance,i.state.loading|=4,hu(u,a.precedence,n));return i.instance}`;
const thirdReviewedFunction = String.raw`function Ib(n,r,o){if(r.count++,r.instance===null)switch(r.type){case"style":var l=n.querySelector('style[data-href~="'+$n(o.href)+'"]');if(l)return r.instance=l,Rt(l),l;var d=y({},o,{"data-href":o.href,"data-precedence":o.precedence,href:null,precedence:null});return l=(n.ownerDocument||n).createElement("style"),Rt(l),Bt(l,"style",d),su(l,o.precedence,n),r.instance=l;case"stylesheet":d=to(o.href);var m=n.querySelector(ha(d));if(m)return r.state.loading|=4,r.instance=m,Rt(m),m;l=Mb(o),(d=Kn.get(d))&&vd(l,d),m=(n.ownerDocument||n).createElement("link"),Rt(m);var k=m;return k._p=new Promise(function(S,R){k.onload=S,k.onerror=R}),Bt(m,"link",l),r.state.loading|=4,su(m,o.precedence,n),r.instance=m;case"script":return m=no(o.src),(d=n.querySelector(pa(m)))?(r.instance=d,Rt(d),d):(l=o,(d=Kn.get(m))&&(l=y({},o),Sd(l,d)),n=n.ownerDocument||n,d=n.createElement("script"),Rt(d),Bt(d,"link",l),n.head.appendChild(d),r.instance=d);case"void":return null;default:throw Error(s(443,r.type))}else r.type==="stylesheet"&&(r.state.loading&4)===0&&(l=r.instance,r.state.loading|=4,su(l,o.precedence,n));return r.instance}`;
const joinedReviewedFunction = String.raw`function Jb(n,i,a){if(i.count++,i.instance===null)switch(i.type){case"style":var u=n.querySelector('style[data-href~="'+$n(a.href)+'"]');if(u)return i.instance=u,Mt(u),u;var d=y({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return u=(n.ownerDocument||n).createElement("style"),Mt(u),Bt(u,"style",d),pu(u,a.precedence,n),i.instance=u;case"stylesheet":d=aa(a.href);var m=n.querySelector(vo(d));if(m)return i.state.loading|=4,i.instance=m,Mt(m),m;u=Wb(a),(d=Gn.get(d))&&Id(u,d),m=(n.ownerDocument||n).createElement("link"),Mt(m);var k=m;return k._p=new Promise(function(S,R){k.onload=S,k.onerror=R}),Bt(m,"link",u),i.state.loading|=4,pu(m,a.precedence,n),i.instance=m;case"script":return m=oa(a.src),(d=n.querySelector(wo(m)))?(i.instance=d,Mt(d),d):(u=a,(d=Gn.get(m))&&(u=y({},a),Dd(u,d)),n=n.ownerDocument||n,d=n.createElement("script"),Mt(d),Bt(d,"link",u),n.head.appendChild(d),i.instance=d);case"void":return null;default:throw Error(s(443,i.type))}else i.type==="stylesheet"&&(i.state.loading&4)===0&&(u=i.instance,i.state.loading|=4,pu(u,a.precedence,n));return i.instance}`;
const uiFirstReviewedFunction = String.raw`function Yb(n,i,a){if(i.count++,i.instance===null)switch(i.type){case"style":var u=n.querySelector('style[data-href~="'+$n(a.href)+'"]');if(u)return i.instance=u,Mt(u),u;var d=y({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return u=(n.ownerDocument||n).createElement("style"),Mt(u),Bt(u,"style",d),pu(u,a.precedence,n),i.instance=u;case"stylesheet":d=aa(a.href);var m=n.querySelector(vo(d));if(m)return i.state.loading|=4,i.instance=m,Mt(m),m;u=Fb(a),(d=Gn.get(d))&&Id(u,d),m=(n.ownerDocument||n).createElement("link"),Mt(m);var k=m;return k._p=new Promise(function(S,R){k.onload=S,k.onerror=R}),Bt(m,"link",u),i.state.loading|=4,pu(m,a.precedence,n),i.instance=m;case"script":return m=oa(a.src),(d=n.querySelector(wo(m)))?(i.instance=d,Mt(d),d):(u=a,(d=Gn.get(m))&&(u=y({},a),Dd(u,d)),n=n.ownerDocument||n,d=n.createElement("script"),Mt(d),Bt(d,"link",u),n.head.appendChild(d),i.instance=d);case"void":return null;default:throw Error(s(443,i.type))}else i.type==="stylesheet"&&(i.state.loading&4)===0&&(u=i.instance,i.state.loading|=4,pu(u,a.precedence,n));return i.instance}`;
const astraReviewedFunction = String.raw`function Vb(n,i,a){if(i.count++,i.instance===null)switch(i.type){case"style":var u=n.querySelector('style[data-href~="'+Mn(a.href)+'"]');if(u)return i.instance=u,_t(u),u;var h=y({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return u=(n.ownerDocument||n).createElement("style"),_t(u),Dt(u,"style",h),hu(u,a.precedence,n),i.instance=u;case"stylesheet":h=ra(a.href);var m=n.querySelector(xo(h));if(m)return i.state.loading|=4,i.instance=m,_t(m),m;u=Ub(a),(h=$n.get(h))&&Ed(u,h),m=(n.ownerDocument||n).createElement("link"),_t(m);var k=m;return k._p=new Promise(function(S,I){k.onload=S,k.onerror=I}),Dt(m,"link",u),i.state.loading|=4,hu(m,a.precedence,n),i.instance=m;case"script":return m=ia(a.src),(h=n.querySelector(vo(m)))?(i.instance=h,_t(h),h):(u=a,(h=$n.get(m))&&(u=y({},a),Cd(u,h)),n=n.ownerDocument||n,h=n.createElement("script"),_t(h),Dt(h,"link",u),n.head.appendChild(h),i.instance=h);case"void":return null;default:throw Error(s(443,i.type))}else i.type==="stylesheet"&&(i.state.loading&4)===0&&(u=i.instance,i.state.loading|=4,hu(u,a.precedence,n));return i.instance}`;
const routingReviewedFunction = String.raw`function Wb(n,i,a){if(i.count++,i.instance===null)switch(i.type){case"style":var u=n.querySelector('style[data-href~="'+Dn(a.href)+'"]');if(u)return i.instance=u,Ot(u),u;var h=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return u=(n.ownerDocument||n).createElement("style"),Ot(u),Lt(u,"style",h),hu(u,a.precedence,n),i.instance=u;case"stylesheet":h=sa(a.href);var m=n.querySelector(vo(h));if(m)return i.state.loading|=4,i.instance=m,Ot(m),m;u=Yb(a),(h=Vn.get(h))&&Tf(u,h),m=(n.ownerDocument||n).createElement("link"),Ot(m);var k=m;return k._p=new Promise(function(S,I){k.onload=S,k.onerror=I}),Lt(m,"link",u),i.state.loading|=4,hu(m,a.precedence,n),i.instance=m;case"script":return m=aa(a.src),(h=n.querySelector(wo(m)))?(i.instance=h,Ot(h),h):(u=a,(h=Vn.get(m))&&(u=g({},a),_f(u,h)),n=n.ownerDocument||n,h=n.createElement("script"),Ot(h),Lt(h,"link",u),n.head.appendChild(h),i.instance=h);case"void":return null;default:throw Error(s(443,i.type))}else i.type==="stylesheet"&&(i.state.loading&4)===0&&(u=i.instance,i.state.loading|=4,hu(u,a.precedence,n));return i.instance}`;
const integratedReviewedFunction = String.raw`function rk(n,i,a){if(i.count++,i.instance===null)switch(i.type){case"style":var c=n.querySelector('style[data-href~="'+$n(a.href)+'"]');if(c)return i.instance=c,Mt(c),c;var h=g({},a,{"data-href":a.href,"data-precedence":a.precedence,href:null,precedence:null});return c=(n.ownerDocument||n).createElement("style"),Mt(c),Ut(c,"style",h),yu(c,a.precedence,n),i.instance=c;case"stylesheet":h=aa(a.href);var m=n.querySelector(So(h));if(m)return i.state.loading|=4,i.instance=m,Mt(m),m;c=nk(a),(h=Kn.get(h))&&Mf(c,h),m=(n.ownerDocument||n).createElement("link"),Mt(m);var x=m;return x._p=new Promise(function(S,I){x.onload=S,x.onerror=I}),Ut(m,"link",c),i.state.loading|=4,yu(m,a.precedence,n),i.instance=m;case"script":return m=oa(a.src),(h=n.querySelector(Ao(m)))?(i.instance=h,Mt(h),h):(c=a,(h=Kn.get(m))&&(c=g({},a),zf(c,h)),n=n.ownerDocument||n,h=n.createElement("script"),Mt(h),Ut(h,"link",c),n.head.appendChild(h),i.instance=h);case"void":return null;default:throw Error(s(443,i.type))}else i.type==="stylesheet"&&(i.state.loading&4)===0&&(c=i.instance,i.state.loading|=4,yu(c,a.precedence,n));return i.instance}`;
const reviewedFunctions = [
  { name: "rk", mark: "Mt", properties: "Ut", otherMark: "unrelatedMarker", resource: "i", element: "c", props: "a", assign: "g", text: integratedReviewedFunction },
  { name: "Vb", text: astraReviewedFunction, mark: "_t", properties: "Dt", otherMark: "Mt", resource: "i", element: "u", props: "a", assign: "y" },
  { name: "Tk", text: firstReviewedFunction, mark: "jt", properties: "$t", otherMark: "Mt", resource: "r", element: "l", props: "a", assign: "g" },
  { name: "Rb", text: secondReviewedFunction, mark: "Mt", properties: "Ut", otherMark: "jt", resource: "r", element: "l", props: "a", assign: "g" },
  { name: "Wb", text: themeReviewedFunction, mark: "zt", properties: "Bt", otherMark: "Mt", resource: "i", element: "u", props: "a", assign: "y" },
  { name: "Ib", text: thirdReviewedFunction, mark: "Rt", properties: "Bt", otherMark: "Mt", resource: "r", element: "l", props: "o", assign: "y" },
  { name: "Jb", text: joinedReviewedFunction, mark: "Mt", properties: "Bt", otherMark: "zt", resource: "i", element: "u", props: "a", assign: "y" },
  { name: "Yb", text: uiFirstReviewedFunction, mark: "Mt", properties: "Bt", otherMark: "zt", resource: "i", element: "u", props: "a", assign: "y" },
  { name: "Wb", text: routingReviewedFunction, mark: "Ot", properties: "Lt", otherMark: "Mt", resource: "i", element: "u", props: "a", assign: "g" },
] as const;
const evidence = {
  manifest: { name: "react-dom", version: "19.2.8" },
  productionClientSha256: "6cf4932e0c20a4572ae395035ca2e512a42d7d49c1a659fa73d6197069c28df0",
};
const artifact = (text: string) => ({ name: "main.js", text });

for (const { name, text: reviewedFunction, mark, properties, otherMark, resource, element, props, assign } of reviewedFunctions) {
  test(`${name}: accepts only the dependency-bound parsed renderer capability`, () => {
    expect(() => assertReviewedRuntimeStyleBoundary([artifact(reviewedFunction)], evidence)).not.toThrow();
  });

  test(`${name}: rejects extra style creation and CSSOM insertion in any emitted chunk`, () => {
    for (const call of [
      'document.createElement("style");',
      'document["createElement"]("STYLE");',
      String.raw`document.createElement("\x73tyle");`,
      'sheet.insertRule("body{display:none}");',
      'sheet["insertRule"]("body{display:none}");',
    ]) {
      expect(() => assertReviewedRuntimeStyleBoundary([
        artifact(reviewedFunction), { name: "extra.js", text: call },
      ], evidence)).toThrow(/Unreviewed/u);
    }
  });

  test(`${name}: rejects changed resource ownership, branch context, and duplicate capabilities`, () => {
    for (const changed of [
      reviewedFunction.replace("n.ownerDocument||n", "document"),
      reviewedFunction.replace(`switch(${resource}.type)`, `switch(${props}.type)`),
      reviewedFunction.replace('case"style":', 'case"other":'),
      `${reviewedFunction}\n${reviewedFunction}`,
      'document.createElement("style");',
    ]) {
      expect(changed).not.toBe(reviewedFunction);
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence))
        .toThrow(/context/u);
    }
  });

  test(`${name}: rejects wrong package identity and changed installed renderer bytes`, () => {
    for (const changed of [
      { ...evidence, manifest: { name: "another-package", version: "19.2.8" } },
      { ...evidence, manifest: { name: "react-dom", version: "19.2.9" } },
      { ...evidence, manifest: null },
      { ...evidence, productionClientSha256: "0".repeat(64) },
    ]) {
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(reviewedFunction)], changed))
        .toThrow(/dependency identity/u);
    }
  });

  test(`${name}: keeps explicit StyleX injector bans even without an extra style call`, () => {
    for (const marker of ["stylex-inject", "stylexInject", "data-stylex", "stylesheet-group"]) {
      expect(() => assertReviewedRuntimeStyleBoundary([
        artifact(`${reviewedFunction}\nvoid ${JSON.stringify(marker)};`),
      ], evidence)).toThrow(/StyleX runtime injector/u);
    }
  });

  test(`${name}: does not accept a string decoy, missing renderer, or malformed JavaScript`, () => {
    for (const text of [JSON.stringify(reviewedFunction), "void 0;", `${reviewedFunction}\nfunction {`]) {
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(text)], evidence)).toThrow();
    }
  });

  test(`${name}: rejects unknown allocations, inconsistent helper reuse and binding collisions`, () => {
    for (const changed of [
      reviewedFunction.replace(`function ${name}(`, "function Unreviewed("),
      reviewedFunction.replace(`${mark}(${element})`, `${otherMark}(${element})`),
      reviewedFunction.replace(`${mark}(${element})`, `${properties}(${element})`),
      reviewedFunction.replaceAll(`${mark}(`, `${assign}(`),
      reviewedFunction.replaceAll(`${mark}(`, "n("),
      // Swap two helper uses without changing either helper's occurrence count.
      reviewedFunction.replace(`${mark}(${element})`, `${properties}(${element})`)
        .replace(`${properties}(${element},"style",`, `${mark}(${element},"style",`),
    ]) {
      expect(changed).not.toBe(reviewedFunction);
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence)).toThrow(/context/u);
    }
  });

  test(`${name}: rejects changed properties, literals, operators, scope and escaped spellings`, () => {
    const escapedMark = `\\u${mark.charCodeAt(0).toString(16).padStart(4, "0")}${mark.slice(1)}`;
    for (const changed of [
      reviewedFunction.replace(".ownerDocument", ".document"),
      reviewedFunction.replace('"data-href":', '"data-src":'),
      reviewedFunction.replace("precedence:null", "precedence:0"),
      reviewedFunction.replace(`${resource}.count++`, `${resource}.count--`),
      reviewedFunction.replace("ownerDocument||n", "ownerDocument&&n"),
      reviewedFunction.replace(`${resource}.instance===null`, `${resource}.instance!==null`),
      reviewedFunction.replace(`(n,${resource},${props})`, `(${resource},n,${props})`),
      reviewedFunction.replace(`{if(${resource}.count++`, `{let ${mark};if(${resource}.count++`),
      `const resource = ${reviewedFunction};`,
      reviewedFunction.replace(`${mark}(${element})`, `${escapedMark}(${element})`),
      reviewedFunction.replace('createElement("style")', String.raw`createElement("\x73tyle")`),
    ]) {
      expect(changed).not.toBe(reviewedFunction);
      expect(() => assertReviewedRuntimeStyleBoundary([artifact(changed)], evidence)).toThrow(/context/u);
    }
  });
}

test("rejects any pair of reviewed allocations occurring together, including separate chunks", () => {
  for (const first of reviewedFunctions) {
    for (const second of reviewedFunctions) {
      if (first === second) continue;
      for (const artifacts of [
        [artifact(`${first.text}\n${second.text}`)],
        [artifact(first.text), { name: "other.js", text: second.text }],
      ]) {
        expect(() => assertReviewedRuntimeStyleBoundary(artifacts, evidence)).toThrow(/Duplicate/u);
      }
    }
  }
});
