package main

import "github.com/dop251/goja"

var vm *goja.Runtime

//export initvm
func initvm() {
	vm = goja.New()
	_, err := vm.RunString(`
		var x = 42;
		var inc = (function(){ var n = x; return function(){ n = n + 1; return n; }; })();
		var store = {};
		function fill(k){ for (var i=0;i<2000;i++){ store["k"+k+"_"+i] = {a:i, s:"val"+i, arr:[i,i+1,i+2]}; } }
		var obj = {deep:{nested:{closure: (function(){var c=100; return function(){return ++c;};})()}}};
	`)
	if err != nil { panic(err) }
}

//export callinc
func callinc() int32 {
	v, _ := vm.RunString(`inc()`); return int32(v.ToInteger())
}
//export getx
func getx() int32 { v,_:=vm.RunString(`x`); return int32(v.ToInteger()) }
//export fillgc
func fillgc(k int32) int32 {
	vm.Set("kk", k)
	v,_ := vm.RunString(`fill(kk); Object.keys(store).length`)
	return int32(v.ToInteger())
}
//export deepclo
func deepclo() int32 { v,_:=vm.RunString(`obj.deep.nested.closure()`); return int32(v.ToInteger()) }

func main() {}
