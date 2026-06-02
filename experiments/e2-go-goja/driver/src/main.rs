use anyhow::Result;
use wasmtime::*;
use wasmtime_wasi::preview1::{self, WasiP1Ctx};
use wasmtime_wasi::WasiCtxBuilder;
struct Inst{store:Store<WasiP1Ctx>,instance:Instance,memory:Memory}
fn mk(e:&Engine,m:&Module)->Result<Inst>{
    let w=WasiCtxBuilder::new().inherit_stdio().build_p1();
    let mut store=Store::new(e,w);
    let mut l:Linker<WasiP1Ctx>=Linker::new(e);
    preview1::add_to_linker_sync(&mut l,|c|c)?;
    let instance=l.instantiate(&mut store,m)?;
    if let Some(i)=instance.get_func(&mut store,"_initialize"){i.call(&mut store,&[],&mut [])?;}
    let memory=instance.get_memory(&mut store,"memory").unwrap();
    Ok(Inst{store,instance,memory})
}
fn ci(i:&mut Inst,n:&str)->Result<i32>{Ok(i.instance.get_typed_func::<(),i32>(&mut i.store,n)?.call(&mut i.store,())?)}
fn ci1(i:&mut Inst,n:&str,a:i32)->Result<i32>{Ok(i.instance.get_typed_func::<i32,i32>(&mut i.store,n)?.call(&mut i.store,a)?)}
fn cv(i:&mut Inst,n:&str)->Result<()>{i.instance.get_typed_func::<(),()>(&mut i.store,n)?.call(&mut i.store,())?;Ok(())}
fn main()->Result<()>{
    let e=Engine::default();
    let m=Module::from_file(&e,"../goja-reactor.wasm")?;
    let mut a=mk(&e,&m)?;
    cv(&mut a,"initvm")?;
    // churn the GC heap hard
    for k in 0..20 { ci1(&mut a,"fillgc",k)?; }
    println!("A: getx={} inc={} deepclo={} deepclo={} storekeys(approx via fillgc more)",
        ci(&mut a,"getx")?, ci(&mut a,"callinc")?, ci(&mut a,"deepclo")?, ci(&mut a,"deepclo")?);
    let data=a.memory.data(&a.store).to_vec();
    println!("A: dumped {} bytes ({:.2}MB) after 20x fillgc (40k objects)",data.len(),data.len() as f64/1048576.0);
    // restore
    let mut b=mk(&e,&m)?;
    let sz=data.len(); let bs=b.memory.data(&b.store).len();
    if bs<sz{b.memory.grow(&mut b.store,((sz-bs+65535)/65536) as u64)?;}
    b.memory.data_mut(&mut b.store)[..sz].copy_from_slice(&data);
    // continue + force MORE GC churn on restored heap to validate pointers
    println!("B(restored): getx={} inc={} deepclo={} (expect 42,44,103)",
        ci(&mut b,"getx")?, ci(&mut b,"callinc")?, ci(&mut b,"deepclo")?);
    for k in 100..130 { let n=ci1(&mut b,"fillgc",k)?; if k==129{println!("B: post-restore fillgc OK, storekeys={}",n);} }
    println!("B(after post-restore churn): inc={} deepclo={}", ci(&mut b,"callinc")?, ci(&mut b,"deepclo")?);
    Ok(())
}
