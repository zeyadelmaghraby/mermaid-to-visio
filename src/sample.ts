export const SAMPLE_CODE = `sequenceDiagram
    actor Source as Source System
    participant IAG as Internal API Gateway
    participant SR as Systems Requests Module
    participant Config as Configurations
    participant Billing as Billing Module
    participant EAG as External API Gateway
    participant Tahseel as Tahseel / SADAD
    activate Source
    Source->>+IAG: 1. CreateBillRequest
    IAG->>IAG: 2. Authenticate and validate source system
    IAG->>+SR: 3. ForwardRequest(System, CreateBillRequest)
    SR->>+Config: 4. Validate request using configured business rules
    Config-->>-SR: Validation result
    alt Validation failed
        SR-->>IAG: Return validation business error
        IAG-->>Source: Return validation business error
    else Validation succeeded
        SR->>SR: 5. Create request record and generate RequestNumber<br/>Status = Received
        SR->>+Billing: 6. CreateBillRequest
        Billing->>Billing: 7. Create bill request record<br/>Status = Received
        Billing->>+EAG: 8. CreateBillRequest
        EAG->>+Tahseel: 9. CreateBillRequest
        Tahseel-->>-EAG: 10. Response(BillDetails)
        EAG-->>-Billing: 11. Response(BillDetails)
        alt Tahseel processing succeeded
            Billing->>Billing: 12. Create bill and timeline entry<br/>Status = Bill Created
            Billing->>Billing: 13. Update bill request status<br/>Status = Processed
        else Tahseel processing failed
            Billing->>Billing: 12. Update bill request status<br/>Status = Failed
        end
        Billing-->>-SR: 14. Response(BillDetails)
        SR->>SR: 15. Update system request status<br/>Status = Processed
        SR-->>IAG: 16. Response(BillDetails)
        IAG-->>Source: 17. Response(BillDetails)
    end
    deactivate SR
    deactivate IAG
    deactivate Source`