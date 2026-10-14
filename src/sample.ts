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
export const ER_SAMPLE_CODE = `erDiagram
    direction TB
    CUS["sales.Customers"] {
        bigint Id PK
        nvarchar(20) Customer_Number UK "NOT NULL"
        nvarchar(250) Name_En "NOT NULL"
        nvarchar(250) Name_Ar
        nvarchar(24) IBAN
        bit Is_Active "NOT NULL"
        datetime Creation_Time "NOT NULL"
        uniqueidentifier Creator_Id
    }
    CUR["cfg.Currencies"] {
        nvarchar(3) Code PK
        nvarchar(100) Name_En "NOT NULL"
        tinyint Decimals "NOT NULL"
    }
    ORD["sales.Orders"] {
        bigint Id PK
        nvarchar(40) Order_Number UK "NOT NULL"
        bigint Customer_Id FK "NOT NULL"
        nvarchar(3) Currency_Code FK "NOT NULL"
        decimal(18,2) Total_Amount "NOT NULL"
        datetime2(7) Order_Date "NOT NULL"
        nvarchar(max) Extra_Properties
        datetime Creation_Time "NOT NULL"
        uniqueidentifier Creator_Id
    }
    ITM["sales.Order_Items"] {
        bigint Order_Id PK, FK
        int Line_Number PK
        bigint Product_Id FK "NOT NULL"
        decimal(18,4) Quantity "NOT NULL"
        decimal(18,2) Unit_Price "NOT NULL"
    }
    PRD["sales.Products"] {
        bigint Id PK
        nvarchar(50) Sku UK "NOT NULL U1"
        bigint Category_Id FK, UK "U1"
        nvarchar(250) Name_En "NOT NULL"
        decimal(18,2) List_Price
    }
    CAT["sales.Product_Categories"] {
        bigint Id PK
        bigint Parent_Category_Id FK
        nvarchar(100) Name_En "NOT NULL"
    }
    PAY["sales.Payments"] {
        bigint Id PK
        bigint Order_Id FK "NOT NULL"
        decimal(18,2) Amount "NOT NULL"
        nvarchar(20) Channel "NOT NULL"
        datetime2(7) Paid_At
    }
    INV["sales.Invoices"] {
        bigint Id PK
        bigint Order_Id FK, UK "NOT NULL"
        nvarchar(40) Invoice_Number "NOT NULL"
        datetime Issued_At "NOT NULL"
    }
    SUM["sales.Customer_Order_Summary_View"]:::view {
        bigint Customer_Id
        nvarchar(250) Name_En
        int Order_Count
        decimal(18,2) Total_Amount
    }
    CUS ||..o{ ORD : places
    CUR ||..o{ ORD : prices
    ORD ||--|{ ITM : contains
    PRD ||..o{ ITM : "ordered as"
    CAT |o..o{ PRD : groups
    CAT |o..o{ CAT : "parent of"
    ORD ||..o{ PAY : "paid by"
    ORD ||..o| INV : "invoiced as"`
