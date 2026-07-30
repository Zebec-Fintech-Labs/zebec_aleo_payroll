// The 'test_aacs_payroll' test program.
import aacs_payroll.aleo;
program test_aacs_payroll.aleo {
    @test
    @should_fail
    fn test_main_fails() {
        let result: u32 = aacs_payroll.aleo::main(2u32, 3u32);
        assert_eq(result, 3u32);
    }

    @noupgrade
    constructor() {}
}
