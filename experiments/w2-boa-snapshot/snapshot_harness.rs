use wasmtime::*;
use wasmtime_wasi::preview1::{self, WasiP1Ctx};
use wasmtime_wasi::WasiCtxBuilder;
fn store(engine:&Engine)->Store<WasiP1Ctx>{
    let wasi=WasiCtxBuilder::new().build_p1();
    Store::new(engine,wasi)
}
fn main()->anyhow::Result<()>{
    let engine=Engine::default();
    let module=Module::from_file(&engine,"/tmp/boaprobe/target/wasm32-wasip1/release/boaprobe.wasm")?;
    let mut linker:Linker<WasiP1Ctx>=Linker::new(&engine);
    preview1::add_to_linker_sync(&mut linker,|t|t)?;
    // Instance A: setup live state
    let mut sa=store(&engine);
    let ia=linker.instantiate(&mut sa,&module)?;
    let setup=ia.get_typed_func::<(),f64>(&mut sa,"setup")?;
    let v=setup.call(&mut sa,())?;
    println!("setup returned {} (expect 41 = inc() after x=40)",v);
    // snapshot triple: memory bytes + stack_pointer global
    let mem=ia.get_memory(&mut sa,"memory").unwrap();
    
    let snap=mem.data(&sa).to_vec();
    
    println!("snapshot: {} bytes (memory-only)",snap.len());
    // Instance B: fresh, blit memory back, restore sp, then probe (NO re-setup)
    let mut sb=store(&engine);
    let ib=linker.instantiate(&mut sb,&module)?;
    let memb=ib.get_memory(&mut sb,"memory").unwrap();
    // grow to match
    let cur=memb.data_size(&sb);
    if snap.len()>cur { memb.grow(&mut sb,((snap.len()-cur)/65536) as u64 +1)?; }
    memb.data_mut(&mut sb)[..snap.len()].copy_from_slice(&snap);
    
    let probe=ib.get_typed_func::<(),f64>(&mut sb,"probe")?;
    let p=probe.call(&mut sb,())?;
    println!("RESTORED probe returned {} (expect 46 = inc()->43 + arr.length 3)",p);
    if (p-46.0).abs()<1e-9 { println!("FIDELITY_PASS: live closure+var+array survived cross-instance memory blit"); }
    else { println!("FIDELITY_FAIL"); }
    Ok(())
}
