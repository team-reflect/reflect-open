/**
 * One index session over an in-memory database.
 */
export class WasmIndex {
  __destroy_into_raw() {
    const ptr = this.__wbg_ptr
    this.__wbg_ptr = 0
    WasmIndexFinalization.unregister(this)
    return ptr
  }
  free() {
    const ptr = this.__destroy_into_raw()
    wasm.__wbg_wasmindex_free(ptr, 0)
  }
  /**
   * Runs `command`; the reply is JSON text. Throws the serialized
   * `AppError`.
   * @param {string} command
   * @param {string} args_json
   * @returns {string}
   */
  call(command, args_json) {
    let deferred4_0
    let deferred4_1
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(command, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      const ptr1 = passStringToWasm0(args_json, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      wasm.wasmindex_call(retptr, this.__wbg_ptr, ptr0, len0, ptr1, len1)
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      var r2 = getDataViewMemory0().getInt32(retptr + 4 * 2, true)
      var r3 = getDataViewMemory0().getInt32(retptr + 4 * 3, true)
      var ptr3 = r0
      var len3 = r1
      if (r3) {
        ptr3 = 0
        len3 = 0
        throw takeObject(r2)
      }
      deferred4_0 = ptr3
      deferred4_1 = len3
      return getStringFromWasm0(ptr3, len3)
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      wasm.__wbindgen_export4(deferred4_0, deferred4_1, 1)
    }
  }
  /**
   * Runs `note_move_indexed`; `rename` moves the file. Throws the
   * serialized `AppError`.
   * @param {string} args_json
   * @param {Function} rename
   */
  move_note(args_json, rename) {
    try {
      const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
      const ptr0 = passStringToWasm0(args_json, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len0 = WASM_VECTOR_LEN
      wasm.wasmindex_move_note(retptr, this.__wbg_ptr, ptr0, len0, addBorrowedObject(rename))
      var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
      var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
      if (r1) {
        throw takeObject(r0)
      }
    } finally {
      wasm.__wbindgen_add_to_stack_pointer(16)
      heap[stack_pointer++] = undefined
    }
  }
  constructor() {
    const ret = wasm.wasmindex_new()
    this.__wbg_ptr = ret
    WasmIndexFinalization.register(this, this.__wbg_ptr, this)
    return this
  }
}
if (Symbol.dispose) WasmIndex.prototype[Symbol.dispose] = WasmIndex.prototype.free

/**
 * Every command that a `WasmIndex` answers.
 * @returns {string[]}
 */
export function index_commands() {
  try {
    const retptr = wasm.__wbindgen_add_to_stack_pointer(-16)
    wasm.index_commands(retptr)
    var r0 = getDataViewMemory0().getInt32(retptr + 4 * 0, true)
    var r1 = getDataViewMemory0().getInt32(retptr + 4 * 1, true)
    var v1 = getArrayJsValueFromWasm0(r0, r1).slice()
    wasm.__wbindgen_export4(r0, r1 * 4, 4)
    return v1
  } finally {
    wasm.__wbindgen_add_to_stack_pointer(16)
  }
}
function __wbg_get_imports() {
  const import0 = {
    __proto__: null,
    __wbg___wbindgen_debug_string_c25d447a39f5578f: function (arg0, arg1) {
      const ret = debugString(getObject(arg1))
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbg___wbindgen_string_get_b0ca35b86a603356: function (arg0, arg1) {
      const obj = getObject(arg1)
      const ret = typeof obj === 'string' ? obj : undefined
      var ptr1 = isLikeNone(ret)
        ? 0
        : passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      var len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbg___wbindgen_throw_344f42d3211c4765: function (arg0, arg1) {
      throw new Error(getStringFromWasm0(arg0, arg1))
    },
    __wbg_call_8a2dd23819f8a60a: function () {
      return handleError(function (arg0, arg1) {
        const ret = getObject(arg0).call(getObject(arg1))
        return addHeapObject(ret)
      }, arguments)
    },
    __wbg_error_a6fa202b58aa1cd3: function (arg0, arg1) {
      let deferred0_0
      let deferred0_1
      try {
        deferred0_0 = arg0
        deferred0_1 = arg1
        console.error(getStringFromWasm0(arg0, arg1))
      } finally {
        wasm.__wbindgen_export4(deferred0_0, deferred0_1, 1)
      }
    },
    __wbg_getDate_a1a40c1c5f40fe3b: function (arg0) {
      const ret = getObject(arg0).getDate()
      return ret
    },
    __wbg_getDay_aa318cce5da74c49: function (arg0) {
      const ret = getObject(arg0).getDay()
      return ret
    },
    __wbg_getFullYear_6af8b229792ae254: function (arg0) {
      const ret = getObject(arg0).getFullYear()
      return ret
    },
    __wbg_getHours_9f6561095682ce51: function (arg0) {
      const ret = getObject(arg0).getHours()
      return ret
    },
    __wbg_getMinutes_b0d5cd90bf9b8f22: function (arg0) {
      const ret = getObject(arg0).getMinutes()
      return ret
    },
    __wbg_getMonth_fffe29d654d5eb69: function (arg0) {
      const ret = getObject(arg0).getMonth()
      return ret
    },
    __wbg_getRandomValues_15134f5c0ae6b0d0: function () {
      return handleError(function (arg0, arg1) {
        globalThis.crypto.getRandomValues(getArrayU8FromWasm0(arg0, arg1))
      }, arguments)
    },
    __wbg_getSeconds_40c565b3a6cb05fe: function (arg0) {
      const ret = getObject(arg0).getSeconds()
      return ret
    },
    __wbg_getTime_d6f070c088c9b5ed: function (arg0) {
      const ret = getObject(arg0).getTime()
      return ret
    },
    __wbg_getTimezoneOffset_dc9862c79e5a81a3: function (arg0) {
      const ret = getObject(arg0).getTimezoneOffset()
      return ret
    },
    __wbg_instanceof_Error_1fdac9f13a8181ba: function (arg0) {
      let result
      try {
        result = getObject(arg0) instanceof Error
      } catch (_) {
        result = false
      }
      const ret = result
      return ret
    },
    __wbg_message_8326fb1d549bebc5: function (arg0) {
      const ret = getObject(arg0).message
      return addHeapObject(ret)
    },
    __wbg_new_0_3da9e97f24fc69be: function () {
      const ret = new Date()
      return addHeapObject(ret)
    },
    __wbg_new_227d7c05414eb861: function () {
      const ret = new Error()
      return addHeapObject(ret)
    },
    __wbg_new_cc984128914cfc6f: function (arg0) {
      const ret = new Date(getObject(arg0))
      return addHeapObject(ret)
    },
    __wbg_new_with_year_month_day_f2354b74b4b2a4f3: function (arg0, arg1, arg2) {
      const ret = new Date(arg0 >>> 0, arg1, arg2)
      return addHeapObject(ret)
    },
    __wbg_random_039a7d5d06e0d333: function () {
      const ret = Math.random()
      return ret
    },
    __wbg_stack_3b0d974bbf31e44f: function (arg0, arg1) {
      const ret = getObject(arg1).stack
      const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_export, wasm.__wbindgen_export2)
      const len1 = WASM_VECTOR_LEN
      getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true)
      getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true)
    },
    __wbindgen_cast_0000000000000001: function (arg0) {
      // Cast intrinsic for `F64 -> Externref`.
      const ret = arg0
      return addHeapObject(ret)
    },
    __wbindgen_cast_0000000000000002: function (arg0, arg1) {
      // Cast intrinsic for `Ref(String) -> Externref`.
      const ret = getStringFromWasm0(arg0, arg1)
      return addHeapObject(ret)
    },
    __wbindgen_object_drop_ref: function (arg0) {
      takeObject(arg0)
    },
  }
  return {
    __proto__: null,
    './reflect_index_wasm_bg.js': import0,
  }
}

const WasmIndexFinalization =
  typeof FinalizationRegistry === 'undefined'
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry((ptr) => wasm.__wbg_wasmindex_free(ptr, 1))

function addHeapObject(obj) {
  if (heap_next === heap.length) heap.push(heap.length + 1)
  const idx = heap_next
  heap_next = heap[idx]

  heap[idx] = obj
  return idx
}

function addBorrowedObject(obj) {
  if (stack_pointer == 1) throw new Error('out of js stack')
  heap[--stack_pointer] = obj
  return stack_pointer
}

function debugString(val) {
  // primitive types
  const type = typeof val
  if (type == 'number' || type == 'boolean' || val == null) {
    return `${val}`
  }
  if (type == 'string') {
    return `"${val}"`
  }
  if (type == 'symbol') {
    const description = val.description
    if (description == null) {
      return 'Symbol'
    } else {
      return `Symbol(${description})`
    }
  }
  if (type == 'function') {
    const name = val.name
    if (typeof name == 'string' && name.length > 0) {
      return `Function(${name})`
    } else {
      return 'Function'
    }
  }
  // objects
  if (Array.isArray(val)) {
    const length = val.length
    let debug = '['
    if (length > 0) {
      debug += debugString(val[0])
    }
    for (let i = 1; i < length; i++) {
      debug += ', ' + debugString(val[i])
    }
    debug += ']'
    return debug
  }
  // Test for built-in
  const builtInMatches = /\[object ([^\]]+)\]/.exec(toString.call(val))
  let className
  if (builtInMatches && builtInMatches.length > 1) {
    className = builtInMatches[1]
  } else {
    // Failed to match the standard '[object ClassName]'
    return toString.call(val)
  }
  if (className == 'Object') {
    // we're a user defined class or Object
    // JSON.stringify avoids problems with cycles, and is generally much
    // easier than looping through ownProperties of `val`.
    try {
      return 'Object(' + JSON.stringify(val) + ')'
    } catch (_) {
      return 'Object'
    }
  }
  // errors
  if (val instanceof Error) {
    return `${val.name}: ${val.message}\n${val.stack}`
  }
  // TODO we could test for more things here, like `Set`s and `Map`s.
  return className
}

function dropObject(idx) {
  if (idx < 1028) return
  heap[idx] = heap_next
  heap_next = idx
}

function getArrayJsValueFromWasm0(ptr, len) {
  ptr = ptr >>> 0
  const mem = getDataViewMemory0()
  const result = []
  for (let i = ptr; i < ptr + 4 * len; i += 4) {
    result.push(takeObject(mem.getUint32(i, true)))
  }
  return result
}

function getArrayU8FromWasm0(ptr, len) {
  ptr = ptr >>> 0
  return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len)
}

let cachedDataViewMemory0 = null
function getDataViewMemory0() {
  if (
    cachedDataViewMemory0 === null ||
    cachedDataViewMemory0.buffer.detached === true ||
    (cachedDataViewMemory0.buffer.detached === undefined &&
      cachedDataViewMemory0.buffer !== wasm.memory.buffer)
  ) {
    cachedDataViewMemory0 = new DataView(wasm.memory.buffer)
  }
  return cachedDataViewMemory0
}

function getStringFromWasm0(ptr, len) {
  return decodeText(ptr >>> 0, len)
}

let cachedUint8ArrayMemory0 = null
function getUint8ArrayMemory0() {
  if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
    cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer)
  }
  return cachedUint8ArrayMemory0
}

function getObject(idx) {
  return heap[idx]
}

function handleError(f, args) {
  try {
    return f.apply(this, args)
  } catch (e) {
    wasm.__wbindgen_export3(addHeapObject(e))
  }
}

let heap = new Array(1024).fill(undefined)
heap.push(undefined, null, true, false)

let heap_next = heap.length

function isLikeNone(x) {
  return x === undefined || x === null
}

function passStringToWasm0(arg, malloc, realloc) {
  if (realloc === undefined) {
    const buf = cachedTextEncoder.encode(arg)
    const ptr = malloc(buf.length, 1) >>> 0
    getUint8ArrayMemory0()
      .subarray(ptr, ptr + buf.length)
      .set(buf)
    WASM_VECTOR_LEN = buf.length
    return ptr
  }

  let len = arg.length
  let ptr = malloc(len, 1) >>> 0

  const mem = getUint8ArrayMemory0()

  let offset = 0

  for (; offset < len; offset++) {
    const code = arg.charCodeAt(offset)
    if (code > 0x7f) break
    mem[ptr + offset] = code
  }
  if (offset !== len) {
    if (offset !== 0) {
      arg = arg.slice(offset)
    }
    ptr = realloc(ptr, len, (len = offset + arg.length * 3), 1) >>> 0
    const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len)
    const ret = cachedTextEncoder.encodeInto(arg, view)

    offset += ret.written
    ptr = realloc(ptr, len, offset, 1) >>> 0
  }

  WASM_VECTOR_LEN = offset
  return ptr
}

let stack_pointer = 1024

function takeObject(idx) {
  const ret = getObject(idx)
  dropObject(idx)
  return ret
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
cachedTextDecoder.decode()
const MAX_SAFARI_DECODE_BYTES = 2146435072
let numBytesDecoded = 0
function decodeText(ptr, len) {
  numBytesDecoded += len
  if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
    cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
    cachedTextDecoder.decode()
    numBytesDecoded = len
  }
  return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len))
}

const cachedTextEncoder = new TextEncoder()

if (!('encodeInto' in cachedTextEncoder)) {
  cachedTextEncoder.encodeInto = function (arg, view) {
    const buf = cachedTextEncoder.encode(arg)
    view.set(buf)
    return {
      read: arg.length,
      written: buf.length,
    }
  }
}

let WASM_VECTOR_LEN = 0

let wasmModule, wasmInstance, wasm
function __wbg_finalize_init(instance, module) {
  wasmInstance = instance
  wasm = instance.exports
  wasmModule = module
  cachedDataViewMemory0 = null
  cachedUint8ArrayMemory0 = null
  return wasm
}

async function __wbg_load(module, imports) {
  if (typeof Response === 'function' && module instanceof Response) {
    if (typeof WebAssembly.instantiateStreaming === 'function') {
      try {
        return await WebAssembly.instantiateStreaming(module, imports)
      } catch (e) {
        const validResponse = module.ok && expectedResponseType(module.type)

        if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
          console.warn(
            '`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n',
            e,
          )
        } else {
          throw e
        }
      }
    }

    const bytes = await module.arrayBuffer()
    return await WebAssembly.instantiate(bytes, imports)
  } else {
    const instance = await WebAssembly.instantiate(module, imports)

    if (instance instanceof WebAssembly.Instance) {
      return { instance, module }
    } else {
      return instance
    }
  }

  function expectedResponseType(type) {
    switch (type) {
      case 'basic':
      case 'cors':
      case 'default':
        return true
    }
    return false
  }
}

function initSync(module) {
  if (wasm !== undefined) return wasm

  if (module !== undefined) {
    if (Object.getPrototypeOf(module) === Object.prototype) {
      ;({ module } = module)
    } else {
      console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
    }
  }

  const imports = __wbg_get_imports()
  if (!(module instanceof WebAssembly.Module)) {
    module = new WebAssembly.Module(module)
  }
  const instance = new WebAssembly.Instance(module, imports)
  return __wbg_finalize_init(instance, module)
}

async function __wbg_init(module_or_path) {
  if (wasm !== undefined) return wasm

  if (module_or_path !== undefined) {
    if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
      ;({ module_or_path } = module_or_path)
    } else {
      console.warn(
        'using deprecated parameters for the initialization function; pass a single object instead',
      )
    }
  }

  if (module_or_path === undefined) {
    module_or_path = new URL('reflect_index_wasm_bg.wasm', import.meta.url)
  }
  const imports = __wbg_get_imports()

  if (
    typeof module_or_path === 'string' ||
    (typeof Request === 'function' && module_or_path instanceof Request) ||
    (typeof URL === 'function' && module_or_path instanceof URL)
  ) {
    module_or_path = fetch(module_or_path)
  }

  const { instance, module } = await __wbg_load(await module_or_path, imports)

  return __wbg_finalize_init(instance, module)
}

export { initSync, __wbg_init as default }
