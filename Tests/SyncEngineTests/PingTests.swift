import Foundation
import XCTest
@testable import SyncEngine

final class PingTests: XCTestCase {
    private let aborted = NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNABORTED))

    func testAPongFollowedByAnAbortResolvesWithThePong() async throws {
        try await firstAnswer { answer in
            answer(nil)
            answer(self.aborted)
        }
    }

    func testTwoErrorsThrowTheFirst() async {
        let refused = NSError(domain: NSPOSIXErrorDomain, code: Int(ECONNREFUSED))
        do {
            try await firstAnswer { answer in
                answer(refused)
                answer(self.aborted)
            }
            XCTFail("ping resolved")
        } catch {
            XCTAssertEqual((error as NSError).code, Int(ECONNREFUSED))
        }
    }

    func testALateAbortFromAnotherThreadIsIgnored() async throws {
        let aborted = aborted
        try await firstAnswer { answer in
            answer(nil)
            DispatchQueue.global().async { answer(aborted) }
        }
        try await Task.sleep(for: .milliseconds(50))
    }
}
