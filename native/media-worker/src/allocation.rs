use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering::Relaxed};

pub const BUDGET_EXIT_CODE: i32 = 86;
static ACTIVE: AtomicBool = AtomicBool::new(false);
static SINGLE: AtomicUsize = AtomicUsize::new(0);
static TOTAL: AtomicUsize = AtomicUsize::new(0);
static USED: AtomicUsize = AtomicUsize::new(0);

#[cfg(unix)]
unsafe extern "C" { fn _exit(status: i32) -> !; }
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" { #[link_name = "ExitProcess"] fn exit_process(status: u32) -> !; }

fn exhausted() -> ! {
    // 分配器不能分配、格式化、加锁或 unwind。直接系统退出，Node 按保留退出码收口。
    #[cfg(unix)] unsafe { _exit(BUDGET_EXIT_CODE) }
    #[cfg(windows)] unsafe { exit_process(BUDGET_EXIT_CODE as u32) }
    #[cfg(not(any(unix, windows)))] std::process::abort()
}
fn charge(bytes: usize) {
    if !ACTIVE.load(Relaxed) { return; }
    if bytes > SINGLE.load(Relaxed) { exhausted(); }
    let maximum = TOTAL.load(Relaxed);
    if USED.fetch_update(Relaxed, Relaxed, |used| used.checked_add(bytes).filter(|next| *next <= maximum)).is_err() { exhausted(); }
}
pub struct BudgetAllocator;
// 安全约定：指针、布局及对齐完全转交 System，不读取已分配内存；护栏只做原子计数。
unsafe impl GlobalAlloc for BudgetAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 { charge(layout.size()); unsafe { System.alloc(layout) } }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 { charge(layout.size()); unsafe { System.alloc_zeroed(layout) } }
    unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) { unsafe { System.dealloc(pointer, layout); } }
    unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        charge(new_size); unsafe { System.realloc(pointer, layout, new_size) }
    }
}
#[global_allocator]
static ALLOCATOR: BudgetAllocator = BudgetAllocator;

pub struct TaskBudget;
impl TaskBudget {
    pub fn begin(single: usize, total: usize) -> Self {
        USED.store(0, Relaxed); SINGLE.store(single, Relaxed); TOTAL.store(total, Relaxed); ACTIVE.store(true, Relaxed); Self
    }
}
impl Drop for TaskBudget { fn drop(&mut self) { ACTIVE.store(false, Relaxed); } }
pub fn used() -> usize { USED.load(Relaxed) }

/** RPC JSON/base64 缓冲独立受固定帧与64KiB读取上限约束，不冒充媒体解析分配。 */
pub struct TransportBudget { previous: bool }
impl TransportBudget { pub fn enter() -> Self { Self { previous: ACTIVE.swap(false, Relaxed) } } }
impl Drop for TransportBudget { fn drop(&mut self) { ACTIVE.store(self.previous, Relaxed); } }
