use boa_engine::{Context, Source};
use std::cell::RefCell;
thread_local!(static CTX: RefCell<Option<Context>> = RefCell::new(None));
fn ev(code:&str)->f64{
    CTX.with(|c|{
        let mut b=c.borrow_mut();
        if b.is_none(){*b=Some(Context::default());}
        let ctx=b.as_mut().unwrap();
        ctx.eval(Source::from_bytes(code.as_bytes())).unwrap().as_number().unwrap_or(f64::NAN)
    })
}
#[no_mangle] pub extern "C" fn setup()->f64{
    // create live state: var, closure, array
    ev("var x=40; function inc(){ x+=1; return x; } var arr=[1,2,3]; inc();")
}
#[no_mangle] pub extern "C" fn probe()->f64{
    // after restore: closure should continue from live state
    ev("inc() + arr.length")  // expect (42+1)=43 ... +3 = 46
}
