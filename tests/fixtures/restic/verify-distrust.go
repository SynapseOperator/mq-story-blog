// A public, revoked CA certificate; no private key or network is used.
// Deliberately trust it as an anchor to test Go's independent SPKI denylist.
package main

import (
    "crypto/sha256"
    "crypto/x509"
    "encoding/hex"
    "encoding/pem"
    "errors"
    "fmt"
    "os"
    "time"
)

func main() {
    data, err := os.ReadFile(os.Args[1])
    if err != nil { panic(err) }
    block, _ := pem.Decode(data)
    if block == nil { panic("certificate fixture missing") }
    cert, err := x509.ParseCertificate(block.Bytes)
    if err != nil { panic(err) }
    fingerprint := sha256.Sum256(cert.RawSubjectPublicKeyInfo)
    if hex.EncodeToString(fingerprint[:]) != "ebed6475c2c2d80fcb199f3fe8dd6e6b3ce60b77eb15d4e42c3dec0c6f5b5105" {
        panic("fixture is not the expected distrusted public key")
    }
    roots := x509.NewCertPool()
    roots.AddCert(cert)
    _, err = cert.Verify(x509.VerifyOptions{Roots:roots,
        CurrentTime:time.Date(2026,11,9,0,0,0,0,time.UTC), KeyUsages:[]x509.ExtKeyUsage{x509.ExtKeyUsageAny}})
    if err == nil {
        fmt.Println("VULNERABLE_CONTROL: distrusted SPKI accepted")
        os.Exit(1)
    }
    var invalid x509.CertificateInvalidError
    if !errors.As(err, &invalid) || invalid.Reason != x509.NoValidChains {
        panic("fixture failed for a reason other than SPKI distrust")
    }
    fmt.Println("PASS: distrusted SPKI rejected despite explicit trust anchor")
}
