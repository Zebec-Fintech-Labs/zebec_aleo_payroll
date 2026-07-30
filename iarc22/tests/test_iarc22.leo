// The 'test_iarc22' test program.
program test_iarc22.aleo {
    @test
    fn test_example() {
        assert_eq(iarc22::example(42u32), 42u32);
    }

    @noupgrade
    constructor() {}
}
